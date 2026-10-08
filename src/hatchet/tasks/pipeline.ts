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
import {
  finishRun, isRunActive, JobStepResult, recordRunSteps, setRunSymbol, startRun,
} from '../../db/admin.js';
import {
  isVerdictStale, newestAnalysisAges, runAnalysisStep, runDataStep, runDistillStep, runReferenceStep,
  scheduledSymbols,
} from '../../pipeline/steps.js';
import { syncWatchlistDossiers } from '../../distill-dossiers.js';
import { sendDigest } from '../../digest.js';
import { watchDepot } from '../../depot-watch-service.js';
import { referenceBatch } from '../../universe.js';
import { logger } from '../../utils/logger.js';
import { settledPool } from '../../utils/pool.js';
import { getHatchet } from '../client.js';
import {
  analysisGate, distillGate,
  FINNHUB_UNITS_PER_REFERENCE, FINNHUB_UNITS_PER_SYMBOL, REFERENCE_CONCURRENCY, YAHOO_UNITS_PER_SYMBOL,
} from '../limits.js';

const hatchet = getHatchet();

// Retry budgets. Data and Distill are network calls against services that fall
// over and come back; analysis costs money per attempt, so it gets fewer.
const DATA_RETRIES     = 3;
const DISTILL_RETRIES  = 3;
const ANALYSIS_RETRIES = 2;
// A reference symbol that fails keeps its old place in the rotation and comes
// round again; retrying it tonight spends the rate limit the rest of the
// universe is queueing for.
const REFERENCE_RETRIES = 1;

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

/**
 * How long a task may sit in the queue before Hatchet gives up on it.
 *
 * Separate from the execution budgets above, and much larger, because they
 * measure different things: ten minutes is generous for one data refresh and
 * absurdly short as a waiting time. The last symbol of a watchlist queues
 * behind every Distill call ahead of it, which is an hour or more — and the
 * default, five minutes, cancels it for being patient. That is what happened
 * on the night of the 22nd.
 */
const QUEUE_TIMEOUT = '6h';

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

// ── The three stages, each on its own ────────────────────────────────────────
//
// Standalone tasks rather than steps of one DAG, and the reason is which worker
// runs them. A worker registers the actions of a whole workflow and pushes that
// workflow's definition as it does so, so a DAG cannot be split across workers
// without one of them overwriting the definition with its own partial view.
// Separate tasks can be registered separately — which is what lets Distill run
// on a worker with a single slot, and be genuinely limited to one at a time
// across every process rather than only within one.
//
// The order between them is kept by the caller below: each reads what the
// previous wrote.

export const dataTask = hatchet.task<SymbolInput, StepOutput>({
  name:    'data',
  retries: DATA_RETRIES,
  executionTimeout: DATA_TIMEOUT,
  scheduleTimeout:  QUEUE_TIMEOUT,
  // Yahoo and Finnhub are billed to separate budgets; the step spends from both.
  rateLimits: [
    { staticKey: 'finnhub', units: FINNHUB_UNITS_PER_SYMBOL },
    { staticKey: 'yahoo',   units: YAHOO_UNITS_PER_SYMBOL },
  ],
  fn: async (input, ctx) => {
    const config = await readAppConfig();
    return settle(
      await runDataStep(config, input.symbol, input.runId),
      input.runId, input.symbol, ctx, DATA_RETRIES,
    );
  },
});

export const distillTask = hatchet.task<SymbolInput, StepOutput>({
  name:    'distill',
  retries: DISTILL_RETRIES,
  executionTimeout: DISTILL_TIMEOUT,
  // Long enough for the whole queue to drain ahead of it, not just the call.
  scheduleTimeout:  QUEUE_TIMEOUT,
  fn: async (input, ctx) => {
    const config = await readAppConfig();
    // The gate is belt to the dedicated worker's braces: on a worker with one
    // slot it never blocks, and on a single worker serving everything (which is
    // what `pnpm dev` starts) it is the only thing holding the line.
    return distillGate.run(async () => settle(
      await runDistillStep(config, input.symbol, input.runId),
      input.runId, input.symbol, ctx, DISTILL_RETRIES,
    ));
  },
});

export const analysisTask = hatchet.task<SymbolInput, StepOutput>({
  name:    'analysis',
  retries: ANALYSIS_RETRIES,
  executionTimeout: ANALYSIS_TIMEOUT,
  scheduleTimeout:  QUEUE_TIMEOUT,
  fn: async (input, ctx) => {
    const config = await readAppConfig();
    return analysisGate.run(async () => settle(
      await runAnalysisStep(config, input.symbol, input.runId, input.ageDays),
      input.runId, input.symbol, ctx, ANALYSIS_RETRIES,
    ));
  },
});

/** A member of the reference universe: the slimmed data step, on the data step's budgets. */
export const referenceTask = hatchet.task<SymbolInput, StepOutput>({
  name:    'reference',
  retries: REFERENCE_RETRIES,
  executionTimeout: DATA_TIMEOUT,
  scheduleTimeout:  QUEUE_TIMEOUT,
  rateLimits: [
    { staticKey: 'finnhub', units: FINNHUB_UNITS_PER_REFERENCE },
    { staticKey: 'yahoo',   units: YAHOO_UNITS_PER_SYMBOL },
  ],
  fn: async (input, ctx) => {
    const config = await readAppConfig();
    return settle(
      await runReferenceStep(config, input.symbol, input.runId),
      input.runId, input.symbol, ctx, REFERENCE_RETRIES,
    );
  },
});

/**
 * One symbol through all three stages, in order.
 *
 * Sequential because each stage reads what the last one wrote: Distill is
 * looked up from the financials the data step refreshed, and the analysis is
 * meant to see the new briefing. The waiting costs nothing here — this runs
 * inside the parent, and the stages themselves are queued on their own workers.
 */
async function runSymbol(
  symbol: string, runId: number, ageDays: number | null, trigger: string,
): Promise<StepOutput[]> {
  const meta = { symbol, runId: String(runId), trigger };
  const input = { symbol, runId, ageDays };
  const out: StepOutput[] = [];
  for (const stage of [dataTask, distillTask, analysisTask]) {
    out.push(await stage.run(input, { additionalMetadata: meta }));
  }
  return out;
}

// ── The whole watchlist ──────────────────────────────────────────────────────

export type PipelineInput = {
  trigger: 'cron' | 'manual';
  /** Explicit subset; empty means every watched symbol. */
  symbols: string[];
};

export type PipelineOutput = {
  runId:     number;
  symbols:   number;
  analysed:  number;
  failed:    number;
  /** Reference symbols refreshed after the watchlist. */
  reference: number;
};

export const pipeline = hatchet.task<PipelineInput, PipelineOutput>({
  name: 'pipeline',
  // The parent outlives every child; it is the run. Retrying it would start a
  // second pass over the whole watchlist, which is never the right repair.
  retries: 0,
  executionTimeout: '12h',
  fn: async (input, ctx): Promise<PipelineOutput> => {
    const config  = await readAppConfig();

    // Same reason as in the in-process scheduler: the dossier switch gates
    // whether Distill builds anything upstream, so the watchlist is mirrored
    // right before the run that depends on it. Hatchet's cron triggers this
    // task directly, so the call has to live on both paths.
    await syncWatchlistDossiers(config)
      .catch((e) => logger.warn(`Distill dossier sync failed: ${(e as Error).message}`));

    const symbols = input.symbols.length
      ? input.symbols.map((s) => s.toUpperCase())
      : await scheduledSymbols();
    // Only after a full run, as in the in-process scheduler.
    const reference = input.symbols.length ? [] : await referenceBatch(config).catch((e) => {
      logger.warn(`Reference universe unavailable: ${(e as Error).message}`);
      return [] as string[];
    });

    // One query for the whole fan-out. Asking per symbol was affordable inside
    // a serial loop; deciding the shape of a fan-out up front is not.
    const ages = await newestAnalysisAges();
    const stale = symbols.filter((s) => isVerdictStale(config, ages.get(s) ?? null));

    const runId = await startRun(input.trigger);
    const opening = `Run ${runId} (${input.trigger}) — ${symbols.length} symbol(s), `
      + `${stale.length} due for analysis`
      + `${reference.length ? `, then ${reference.length} of the reference universe` : ''}`;
    logger.info(`Pipeline ${opening}`);
    await Promise.resolve(ctx.log(opening)).catch(() => { /* ignore */ });

    let failed = 0;
    try {
      // Fired together; the rate limits and concurrency caps decide the real
      // pace. `run` waits for each child to finish so the run row closes on
      // the truth rather than on "everything was queued".
      // Tagged, not just passed as input: Hatchet can filter on metadata, and
      // that filter is what makes "is AAPL busy?" answerable without pulling
      // the whole queue back and sifting it here.
      //
      // `allSettled`, emphatically not `all`. `all` rejects the moment any one
      // symbol does, and this task then returns — at which point Hatchet
      // cancels every stage it had spawned. A single symbol whose Distill ran
      // out of retries took the rest of the watchlist with it: three analyses
      // killed mid-run and four symbols never started, all cancelled within the
      // same millisecond. One dead ticker costs its own symbol and nothing else.
      const settled = await Promise.allSettled(symbols.map((symbol) =>
        runSymbol(symbol, runId, ages.get(symbol) ?? null, input.trigger)));

      for (const [i, outcome] of settled.entries()) {
        if (outcome.status === 'rejected') {
          // The steps it did finish are already in run_steps; what is lost is
          // only the rest of its chain, so it counts once and is named.
          failed++;
          logger.warn(`${symbols[i]}: pipeline rejected — ${
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
          continue;
        }
        for (const step of outcome.value) {
          if (step?.status === 'failed') failed++;
        }
      }

      // The morning's message once the watchlist has settled — it is about the
      // watchlist, and the universe behind it takes hours.
      if (!input.symbols.length) {
        await sendDigest().catch((e) => logger.warn(`Digest failed: ${(e as Error).message}`));
        await watchDepot().catch((e) => logger.warn(`Depot watch failed: ${(e as Error).message}`));
      }

      // The universe after the watchlist has settled, never beside it: the
      // watchlist is what someone reads in the morning, and the two draw on
      // the same Yahoo and Finnhub budgets. A few at a time rather than all at
      // once, and each batch asks whether the run was stopped, since a stop
      // can only cancel what is already queued. Its failures do not make the
      // run partial — the rotation comes round to a failed symbol again.
      const refs = await settledPool(reference, REFERENCE_CONCURRENCY, (symbol) => referenceTask.run(
        { symbol, runId, ageDays: null },
        { additionalMetadata: { symbol, runId: String(runId), trigger: input.trigger } },
      ), () => isRunActive(runId));
      const refFailed = refs.filter((r) => r.status === 'rejected' || r.value?.status === 'failed').length;
      if (refFailed > 0) logger.warn(`Run ${runId}: ${refFailed} of ${reference.length} reference refreshes failed`);

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
    }

    return { runId, symbols: symbols.length, analysed: stale.length, failed, reference: reference.length };
  },
});
