/**
 * The nightly pipeline as a Hatchet workflow.
 *
 * The shape mirrors what `scheduler.ts` does serially, with two differences
 * that are the entire reason for moving it:
 *
 *   - Each step is its own task, so each carries its own rate limit,
 *     concurrency cap and retry budget. Symbols overlap: while one waits its
 *     turn for Distill, the next is already fetching data.
 *   - A failed step is retried with backoff instead of being written off until
 *     the next night. Of 34 symbols in the last recorded run, 28 lost their
 *     briefing to a bare `fetch failed` while Distill was still coming up.
 *
 * Steps still run in order per symbol, because each reads what the previous
 * wrote: Distill is looked up from the financials the data step refreshed, and
 * the analysis is supposed to see the new briefing.
 *
 * Run rows are still written to `runs`/`run_steps`. Hatchet's dashboard is for
 * operating the queue; the admin page is part of the product, and it reads
 * Postgres.
 */

import { ConcurrencyLimitStrategy } from '@hatchet-dev/typescript-sdk';

import { readAppConfig } from '../../app-config.js';
import { finishRun, JobStepResult, pruneRuns, recordRunSteps, setRunSymbol, startRun } from '../../db/admin.js';
import {
  isVerdictStale, newestAnalysisAges, runAnalysisStep, runDataStep, runDistillStep, scheduledSymbols,
} from '../../pipeline/steps.js';
import { logger } from '../../utils/logger.js';
import { getHatchet } from '../client.js';
import {
  ANALYSIS_CONCURRENCY, DISTILL_CONCURRENCY,
  FINNHUB_UNITS_PER_SYMBOL, YAHOO_UNITS_PER_SYMBOL,
} from '../limits.js';

const hatchet = getHatchet();

// Retry budgets. Data and Distill are network calls against services that fall
// over and come back; analysis costs money per attempt, so it gets fewer.
const DATA_RETRIES     = 3;
const DISTILL_RETRIES  = 3;
const ANALYSIS_RETRIES = 2;

export type SymbolInput = {
  symbol: string;
  runId:  number;
  /** Age of the newest verdict, decided once by the parent. Null = never. */
  ageDays: number | null;
};

type StepOutput = { status: string; detail: string; ms: number };

/**
 * Record a step, or throw to buy another attempt.
 *
 * The step functions report failure rather than throwing, which is right for
 * the serial scheduler — one dead ticker must not stop the walk. Hatchet only
 * retries on a thrown error, so a failure is re-thrown while attempts remain
 * and recorded once they are spent. The row therefore describes the final
 * outcome, and the retries are visible in Hatchet rather than in the run log.
 */
async function settle(
  result: JobStepResult, runId: number, symbol: string, attempt: number, retries: number,
): Promise<StepOutput> {
  if (result.status === 'failed' && attempt < retries) {
    logger.warn(`${symbol} ${result.step} failed (attempt ${attempt + 1}/${retries + 1}): ${result.detail}`);
    throw new Error(`${result.step} failed: ${result.detail}`);
  }
  await recordRunSteps(runId, symbol, [result]);
  return { status: result.status, detail: result.detail, ms: result.ms };
}

// ── One symbol, three stages ─────────────────────────────────────────────────

export const symbolPipeline = hatchet.workflow<SymbolInput, {
  data: StepOutput; distill: StepOutput; analysis: StepOutput;
}>({ name: 'symbol-pipeline' });

const data = symbolPipeline.task({
  name:    'data',
  retries: DATA_RETRIES,
  // Yahoo and Finnhub are billed to separate budgets; the step spends from both.
  rateLimits: [
    { staticKey: 'finnhub', units: FINNHUB_UNITS_PER_SYMBOL },
    { staticKey: 'yahoo',   units: YAHOO_UNITS_PER_SYMBOL },
  ],
  fn: async (input: SymbolInput, ctx) => {
    const config = await readAppConfig();
    return settle(
      await runDataStep(config, input.symbol, input.runId),
      input.runId, input.symbol, ctx.retryCount(), DATA_RETRIES,
    );
  },
});

const distill = symbolPipeline.task({
  name:    'distill',
  parents: [data],
  retries: DISTILL_RETRIES,
  // A constant expression means every run shares one key, which is how a
  // global cap is spelled. QUEUE_NEWEST rather than the default
  // CANCEL_IN_PROGRESS: cancelling would leave the night with a single
  // briefing, since each new symbol would kill the one before it.
  concurrency: {
    expression:    "'distill'",
    maxRuns:       DISTILL_CONCURRENCY,
    limitStrategy: ConcurrencyLimitStrategy.QUEUE_NEWEST,
  },
  fn: async (input: SymbolInput, ctx) => {
    const config = await readAppConfig();
    return settle(
      await runDistillStep(config, input.symbol, input.runId),
      input.runId, input.symbol, ctx.retryCount(), DISTILL_RETRIES,
    );
  },
});

symbolPipeline.task({
  name:    'analysis',
  parents: [distill],
  retries: ANALYSIS_RETRIES,
  concurrency: {
    expression:    "'analysis'",
    maxRuns:       ANALYSIS_CONCURRENCY,
    limitStrategy: ConcurrencyLimitStrategy.QUEUE_NEWEST,
  },
  fn: async (input: SymbolInput, ctx) => {
    const config = await readAppConfig();
    return settle(
      await runAnalysisStep(config, input.symbol, input.runId, input.ageDays),
      input.runId, input.symbol, ctx.retryCount(), ANALYSIS_RETRIES,
    );
  },
});

// ── The whole watchlist ──────────────────────────────────────────────────────

export type PipelineInput = {
  trigger: 'cron' | 'manual';
  /** Explicit subset; empty means every watched symbol. */
  symbols: string[];
};

export type PipelineOutput = {
  runId:    number;
  symbols:  number;
  analysed: number;
  failed:   number;
};

export const pipeline = hatchet.task<PipelineInput, PipelineOutput>({
  name: 'pipeline',
  // The parent outlives every child; it is the run. Retrying it would start a
  // second pass over the whole watchlist, which is never the right repair.
  retries: 0,
  executionTimeout: '12h',
  fn: async (input): Promise<PipelineOutput> => {
    const config  = await readAppConfig();
    const symbols = input.symbols.length
      ? input.symbols.map((s) => s.toUpperCase())
      : await scheduledSymbols(config);

    // One query for the whole fan-out. Asking per symbol was affordable inside
    // a serial loop; deciding the shape of a fan-out up front is not.
    const ages = await newestAnalysisAges();
    const stale = symbols.filter((s) => isVerdictStale(config, ages.get(s) ?? null));

    const runId = await startRun(input.trigger);
    logger.info(
      `Pipeline run ${runId} started (${input.trigger}) — ${symbols.length} symbol(s), `
      + `${stale.length} due for analysis`,
    );

    let failed = 0;
    try {
      // Fired together; the rate limits and concurrency caps decide the real
      // pace. `run` waits for each child to finish so the run row closes on
      // the truth rather than on "everything was queued".
      const results = await symbolPipeline.run(
        symbols.map((symbol) => ({ symbol, runId, ageDays: ages.get(symbol) ?? null })),
      );
      for (const r of results) {
        for (const step of [r.data, r.distill, r.analysis]) {
          if (step?.status === 'failed') failed++;
        }
      }
      await finishRun(runId, failed > 0 ? 'partial' : 'ok');
    } catch (e) {
      // A child that exhausts its retries rejects the whole bulk run. The work
      // other symbols completed is already in run_steps, so the run is partial
      // rather than lost.
      failed++;
      logger.error(`Pipeline run ${runId}: ${(e as Error).message}`);
      await finishRun(runId, 'partial', (e as Error).message);
    } finally {
      await setRunSymbol(runId, null).catch(() => { /* cosmetic */ });
      await pruneRuns().catch(() => { /* retention is best effort */ });
    }

    return { runId, symbols: symbols.length, analysed: stale.length, failed };
  },
});
