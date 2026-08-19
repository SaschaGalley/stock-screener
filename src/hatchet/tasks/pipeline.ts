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

import { readAppConfig } from '../../app-config.js';
import { finishRun, JobStepResult, pruneRuns, recordRunSteps, setRunSymbol, startRun } from '../../db/admin.js';
import {
  isVerdictStale, newestAnalysisAges, runAnalysisStep, runDataStep, runDistillStep, scheduledSymbols,
} from '../../pipeline/steps.js';
import { logger } from '../../utils/logger.js';
import { getHatchet } from '../client.js';
import { Gate } from '../gate.js';
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

// How many may be in flight, enforced by waiting. See `gate.ts` for why this is
// not Hatchet's own concurrency option.
const distillGate  = new Gate(DISTILL_CONCURRENCY);
const analysisGate = new Gate(ANALYSIS_CONCURRENCY);

/**
 * How long a task may take before Hatchet decides the worker lost it.
 *
 * The default is a minute, which is shorter than the work: a Distill refresh
 * has been measured at 113s, and the first run of this pipeline duly had one
 * restarted mid-flight and generate the same briefing twice.
 *
 * These have to cover the wait at the gate as well as the work itself, because
 * a task holds its slot while queueing. Distill is the extreme case — capped at
 * one in flight, a full watchlist means the last symbol waits behind every
 * other, so the budget is sized for the queue rather than for one call.
 */
const DATA_TIMEOUT     = '10m';
const DISTILL_TIMEOUT  = '3h';
const ANALYSIS_TIMEOUT = '2h';

export type SymbolInput = {
  symbol: string;
  runId:  number;
  /** Age of the newest verdict, decided once by the parent. Null = never. */
  ageDays: number | null;
};

type StepOutput = { status: string; detail: string; ms: number };

/** Just enough of the task context to report progress; keeps `settle` testable. */
type StepContext = { retryCount(): number; log(message: string, level?: 'INFO' | 'WARN' | 'ERROR'): unknown };

/**
 * Record a step, or throw to buy another attempt.
 *
 * The step functions report failure rather than throwing, which is right for
 * the serial scheduler — one dead ticker must not stop the walk. Hatchet only
 * retries on a thrown error, so a failure is re-thrown while attempts remain
 * and recorded once they are spent. The row therefore describes the final
 * outcome, and the retries are visible in Hatchet rather than in the run log.
 *
 * The same line goes to `ctx.log`, which attaches it to the task run in
 * Hatchet's dashboard. Worth the duplication: `run_steps` keeps only the final
 * outcome, so without this the attempts that led there are visible in neither
 * place — and a run being retried is exactly when someone goes looking.
 */
async function settle(
  result: JobStepResult, runId: number, symbol: string, ctx: StepContext, retries: number,
): Promise<StepOutput> {
  const attempt = ctx.retryCount();
  const where   = `${symbol} ${result.step}`;

  if (result.status === 'failed' && attempt < retries) {
    const line = `${where} failed (attempt ${attempt + 1}/${retries + 1}): ${result.detail}`;
    logger.warn(line);
    // Best effort: losing a log line must not cost the retry it describes.
    await Promise.resolve(ctx.log(line, 'WARN')).catch(() => { /* ignore */ });
    throw new Error(`${result.step} failed: ${result.detail}`);
  }

  const line = `${where} ${result.status} in ${result.ms}ms — ${result.detail}`;
  await Promise.resolve(ctx.log(line, result.status === 'failed' ? 'ERROR' : 'INFO'))
    .catch(() => { /* ignore */ });

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
  executionTimeout: DATA_TIMEOUT,
  // Yahoo and Finnhub are billed to separate budgets; the step spends from both.
  rateLimits: [
    { staticKey: 'finnhub', units: FINNHUB_UNITS_PER_SYMBOL },
    { staticKey: 'yahoo',   units: YAHOO_UNITS_PER_SYMBOL },
  ],
  fn: async (input: SymbolInput, ctx) => {
    const config = await readAppConfig();
    return settle(
      await runDataStep(config, input.symbol, input.runId),
      input.runId, input.symbol, ctx, DATA_RETRIES,
    );
  },
});

const distill = symbolPipeline.task({
  name:    'distill',
  parents: [data],
  retries: DISTILL_RETRIES,
  executionTimeout: DISTILL_TIMEOUT,
  // Long enough for the whole queue to drain ahead of it, not just the call.
  scheduleTimeout:  DISTILL_TIMEOUT,
  fn: async (input: SymbolInput, ctx) => {
    const config = await readAppConfig();
    return distillGate.run(async () => settle(
      await runDistillStep(config, input.symbol, input.runId),
      input.runId, input.symbol, ctx, DISTILL_RETRIES,
    ));
  },
});

symbolPipeline.task({
  name:    'analysis',
  parents: [distill],
  retries: ANALYSIS_RETRIES,
  executionTimeout: ANALYSIS_TIMEOUT,
  scheduleTimeout:  ANALYSIS_TIMEOUT,
  fn: async (input: SymbolInput, ctx) => {
    const config = await readAppConfig();
    return analysisGate.run(async () => settle(
      await runAnalysisStep(config, input.symbol, input.runId, input.ageDays),
      input.runId, input.symbol, ctx, ANALYSIS_RETRIES,
    ));
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
  fn: async (input, ctx): Promise<PipelineOutput> => {
    const config  = await readAppConfig();
    const symbols = input.symbols.length
      ? input.symbols.map((s) => s.toUpperCase())
      : await scheduledSymbols(config);

    // One query for the whole fan-out. Asking per symbol was affordable inside
    // a serial loop; deciding the shape of a fan-out up front is not.
    const ages = await newestAnalysisAges();
    const stale = symbols.filter((s) => isVerdictStale(config, ages.get(s) ?? null));

    const runId = await startRun(input.trigger);
    const opening = `Run ${runId} (${input.trigger}) — ${symbols.length} symbol(s), `
      + `${stale.length} due for analysis`;
    logger.info(`Pipeline ${opening}`);
    await Promise.resolve(ctx.log(opening)).catch(() => { /* ignore */ });

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
      await Promise.resolve(ctx.log(
        `Run ${runId} finished — ${symbols.length} symbol(s), ${failed} failed step(s)`,
        failed > 0 ? 'WARN' : 'INFO',
      )).catch(() => { /* ignore */ });
    } catch (e) {
      // A child that exhausts its retries rejects the whole bulk run. The work
      // other symbols completed is already in run_steps, so the run is partial
      // rather than lost.
      failed++;
      // Not always an Error: a rejected bulk run can surface as a bare value,
      // and `undefined` in the run row helps nobody.
      const reason = e instanceof Error ? e.message : String(e ?? 'unknown failure');
      logger.error(`Pipeline run ${runId}: ${reason}`);
      await Promise.resolve(ctx.log(`Run ${runId} failed: ${reason}`, 'ERROR')).catch(() => { /* ignore */ });
      await finishRun(runId, 'partial', reason);
    } finally {
      await setRunSymbol(runId, null).catch(() => { /* cosmetic */ });
      await pruneRuns().catch(() => { /* retention is best effort */ });
    }

    return { runId, symbols: symbols.length, analysed: stale.length, failed };
  },
});
