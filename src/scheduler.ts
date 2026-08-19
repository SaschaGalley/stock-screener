/**
 * The nightly pipeline: one cron, one queue, one symbol at a time.
 *
 * Serial on purpose. Every step here talks to a rate-limited third party
 * (Yahoo, Finnhub, Distill, an LLM) and writes into the same symbol's history;
 * running symbols in parallel would multiply the ways those two facts can
 * collide for a run that has all night to finish anyway. The only concurrency
 * control needed is therefore "is a run active?" — a second trigger, cron or
 * manual, is refused rather than queued, because two runs of the same pipeline
 * would do the same work twice.
 *
 * Per symbol, in order:
 *   1. data     — Yahoo/Finnhub/FRED/macro refresh + technicals + models
 *   2. distill  — refresh (POST, generates briefings) or fetch (GET, free)
 *   3. analysis — only when the newest verdict is older than `maxAgeDays`,
 *                 forced past the stored verdict so it produces an actual new one
 *
 * Runs are rows in `runs` / `run_steps`, so the admin page can show what
 * happened last night after a restart — and so every observation written
 * during the run can point back at the run that produced it.
 */

import cron, { type ScheduledTask } from 'node-cron';

import { logger } from './utils/logger.js';
import { isHatchetConfigured } from './hatchet/client.js';
import { AppConfig, readAppConfig } from './app-config.js';
import {
  finishRun, JobRun, JobRunStatus, JobStep, JobStepResult, JobSymbolResult,
  listRuns, pruneRuns, reapStaleRuns, recordRunSteps, setRunSymbol, startRun, StepStatus,
} from './db/admin.js';
import { runAnalysisStep, runDataStep, runDistillStep, scheduledSymbols } from './pipeline/steps.js';

export type { JobRun, JobRunStatus, JobStep, JobStepResult, JobSymbolResult, StepStatus };
export { scheduledSymbols };

// ── Module state ─────────────────────────────────────────────────────────────
// A single active run and a single installed cron task. Both are per-process,
// which is exactly right for the single-container deployment this ships as.
// The live run is mirrored in memory so polling /api/jobs during a run doesn't
// reassemble it from the database on every tick.

let task: ScheduledTask | null = null;
let activeRun: JobRun | null = null;
let stopRequested = false;

// ── One symbol ───────────────────────────────────────────────────────────────

/** Run every enabled step for one symbol, in order, collecting the outcomes. */
async function processSymbol(
  config: AppConfig,
  symbol: string,
  runId: number,
): Promise<JobSymbolResult> {
  const startedAt = Date.now();
  const steps: JobStepResult[] = [
    await runDataStep(config, symbol, runId),
    await runDistillStep(config, symbol, runId),
    await runAnalysisStep(config, symbol, runId),
  ];

  await recordRunSteps(runId, symbol, steps);
  return { symbol, steps, ms: Date.now() - startedAt };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface RunOptions {
  trigger: 'cron' | 'manual';
  /** Explicit subset; defaults to every watched symbol with stored financials. */
  symbols?: string[];
}

export class JobBusyError extends Error {
  constructor() {
    super('A pipeline run is already in progress.');
    this.name = 'JobBusyError';
  }
}

/** Running tally, so the live view matches what the database will report. */
function tally(symbols: JobSymbolResult[]): JobRun['totals'] {
  const totals = { symbols: symbols.length, data: 0, distill: 0, analysis: 0, failed: 0 };
  for (const sym of symbols) {
    for (const step of sym.steps) {
      if (step.status === 'ok') totals[step.step]++;
      if (step.status === 'failed') totals.failed++;
    }
  }
  return totals;
}

/**
 * Walk the watchlist serially. Resolves with the finished run; step failures
 * are recorded per symbol and never abort the rest of the list — one dead
 * ticker must not cost the other forty their nightly update.
 */
export async function runPipeline(opts: RunOptions): Promise<JobRun> {
  // With Hatchet configured the queue owns the run: it survives a restart of
  // this process, retries individual steps, and paces symbols against the
  // rate limits. This path stays for installations without a token.
  if (isHatchetConfigured()) return runPipelineOnHatchet(opts);

  if (activeRun) throw new JobBusyError();

  const config = await readAppConfig();
  const symbols = opts.symbols?.length
    ? opts.symbols.map((s) => s.toUpperCase())
    : await scheduledSymbols(config);

  const runId = await startRun(opts.trigger);
  const run: JobRun = {
    id:            String(runId),
    trigger:       opts.trigger,
    startedAt:     new Date().toISOString(),
    finishedAt:    null,
    status:        'running',
    currentSymbol: null,
    symbols:       [],
    totals:        { symbols: symbols.length, data: 0, distill: 0, analysis: 0, failed: 0 },
  };
  activeRun = run;
  stopRequested = false;

  logger.info(`Pipeline run started (${opts.trigger}) — ${symbols.length} symbol(s)`);

  try {
    for (const symbol of symbols) {
      if (stopRequested) {
        run.status = 'stopped';
        break;
      }
      run.currentSymbol = symbol;
      await setRunSymbol(runId, symbol);
      const result = await processSymbol(config, symbol, runId);
      run.symbols.push(result);
      run.totals = { ...tally(run.symbols), symbols: symbols.length };
    }

    if (run.status !== 'stopped') {
      run.status = run.totals.failed > 0 ? 'partial' : 'ok';
    }
  } catch (e) {
    run.status = 'failed';
    run.error = (e as Error).message;
    logger.error(`Pipeline run failed: ${run.error}`);
  } finally {
    run.currentSymbol = null;
    run.finishedAt = new Date().toISOString();
    await finishRun(runId, run.status, run.error).catch((e) =>
      logger.warn(`Could not finalise run ${runId}: ${(e as Error).message}`));
    await pruneRuns().catch(() => { /* retention is best effort */ });
    activeRun = null;
    stopRequested = false;
    const secs = ((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(0);
    logger.success(
      `Pipeline run ${run.status} in ${secs}s — data ${run.totals.data}, distill ${run.totals.distill}, `
      + `analysis ${run.totals.analysis}, failed ${run.totals.failed}`,
    );
  }

  return run;
}

/**
 * Start a run and return as soon as it is *accepted*, not finished.
 *
 * The distinction matters because a full pass takes minutes to hours, far past
 * any HTTP timeout. On Hatchet accepting means enqueued, which is a round trip;
 * in-process it means the single slot was claimed, and the walk itself is left
 * running behind the response. Throws `JobBusyError` if a run is already going.
 */
export async function startPipeline(opts: RunOptions): Promise<void> {
  if (isHatchetConfigured()) {
    await runPipelineOnHatchet(opts);
    return;
  }
  if (activeRun) throw new JobBusyError();
  void runPipeline(opts).catch((e) =>
    logger.error(`Pipeline run failed: ${(e as Error).message}`));
}

/**
 * Hand the run to Hatchet and report it the way the admin page expects.
 *
 * Enqueued without waiting: a full pass runs for minutes to hours, and the
 * caller is an HTTP handler. Progress is read back out of `runs`/`run_steps`,
 * which the tasks write as they go — so unlike the in-process path, the view
 * survives a restart of this process.
 */
async function runPipelineOnHatchet(opts: RunOptions): Promise<JobRun> {
  if (await isPipelineRunningInDb()) throw new JobBusyError();

  const { pipeline } = await import('./hatchet/tasks/pipeline.js');
  await pipeline.runNoWait({
    trigger: opts.trigger,
    symbols: opts.symbols ?? [],
  });

  logger.info(`Pipeline run queued on Hatchet (${opts.trigger})`);
  const [latest] = await listRuns(1);
  return latest ?? {
    id: 'queued', trigger: opts.trigger, startedAt: new Date().toISOString(),
    finishedAt: null, status: 'running', currentSymbol: null, symbols: [],
    totals: { symbols: 0, data: 0, distill: 0, analysis: 0, failed: 0 },
  };
}

/**
 * Is a run in flight according to the database?
 *
 * The in-memory flag only knows about runs this process started. Under Hatchet
 * the work happens in the worker, so the run row is the only shared truth.
 */
async function isPipelineRunningInDb(): Promise<boolean> {
  const [latest] = await listRuns(1);
  return latest?.status === 'running';
}

/** True while a run occupies the single pipeline slot. */
export function isPipelineRunning(): boolean {
  return activeRun !== null;
}

/** Ask the active run to stop after the symbol it is currently on. */
export function requestStop(): boolean {
  if (!activeRun) return false;
  stopRequested = true;
  logger.warn('Pipeline stop requested — finishing the current symbol first.');
  return true;
}

export interface SchedulerStatus {
  /** Installed cron expression, or null when the schedule is off. */
  cron:      string | null;
  timezone:  string;
  nextRun:   string | null;
  running:   boolean;
  current:   JobRun | null;
  runs:      JobRun[];
  /** Symbols the next run would cover. */
  watched:   string[];
}

export async function getSchedulerStatus(): Promise<SchedulerStatus> {
  const config = await readAppConfig();
  const next = task?.getNextRun() ?? null;
  const [runs, watched] = await Promise.all([listRuns(), scheduledSymbols(config)]);

  // Under Hatchet the run lives in the worker process, so the stored row is the
  // only thing this process can see — and it is the better answer anyway, since
  // it outlives a restart. Without Hatchet the in-memory run is ahead of the
  // stored one mid-symbol, so that one wins.
  const hatchet = isHatchetConfigured();
  const stored  = runs[0]?.status === 'running' ? runs[0] : null;

  return {
    cron:     hatchet ? (config.schedule.enabled ? config.schedule.cron : null)
                      : (task ? config.schedule.cron : null),
    timezone: config.schedule.timezone,
    nextRun:  next ? next.toISOString() : null,
    running:  hatchet ? stored !== null : activeRun !== null,
    current:  hatchet ? stored : activeRun,
    runs,
    watched,
  };
}

/**
 * Install (or remove) the cron task for the current config. Idempotent — call
 * it at boot and again after every config change.
 */
export async function applySchedule(): Promise<void> {
  if (task) {
    task.destroy();
    task = null;
  }

  const config = await readAppConfig();

  // One scheduler or the other, never both — two crons would run the watchlist
  // twice a night.
  if (isHatchetConfigured()) {
    const { syncHatchetCron } = await import('./hatchet/cron.js');
    await syncHatchetCron(config);
    return;
  }

  if (!config.schedule.enabled) {
    logger.info('Pipeline schedule is disabled — no cron installed.');
    return;
  }

  if (!cron.validate(config.schedule.cron)) {
    logger.error(`Invalid cron expression "${config.schedule.cron}" — schedule not installed.`);
    return;
  }

  task = cron.schedule(
    config.schedule.cron,
    async () => {
      if (activeRun) {
        logger.warn('Cron fired while a run was still active — skipping this tick.');
        return;
      }
      try {
        await runPipeline({ trigger: 'cron' });
      } catch (e) {
        // Never let a scheduled run take the process down.
        logger.error(`Scheduled run failed: ${(e as Error).message}`);
      }
    },
    { timezone: config.schedule.timezone, name: 'stock-pipeline' },
  );

  const next = task.getNextRun();
  logger.success(
    `Pipeline scheduled: "${config.schedule.cron}" (${config.schedule.timezone})`
    + `${next ? ` — next run ${next.toISOString()}` : ''}`,
  );
}

/**
 * Boot-time cleanup: a run interrupted by a restart is still marked `running`
 * in the database, and nothing in this process is executing it.
 */
export async function recoverInterruptedRuns(): Promise<void> {
  await reapStaleRuns();
}
