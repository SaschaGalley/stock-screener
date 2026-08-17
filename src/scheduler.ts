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

import { getConfig } from './config.js';
import { logger } from './utils/logger.js';
import { AppConfig, isWatched, readAppConfig } from './app-config.js';
import {
  finishRun, JobRun, JobRunStatus, JobStep, JobStepResult, JobSymbolResult,
  listRuns, pruneRuns, reapStaleRuns, recordRunSteps, setRunSymbol, startRun, StepStatus,
} from './db/admin.js';
import { listAnalyses, listSymbols, readFinancialsLax } from './db/store.js';
import { refreshStockData } from './refresh.js';
import { runAnalysis } from './cli.js';
import { distillHintsFor, syncDistillBriefing } from './distill-service.js';

export type { JobRun, JobRunStatus, JobStep, JobStepResult, JobSymbolResult, StepStatus };

// ── Module state ─────────────────────────────────────────────────────────────
// A single active run and a single installed cron task. Both are per-process,
// which is exactly right for the single-container deployment this ships as.
// The live run is mirrored in memory so polling /api/jobs during a run doesn't
// reassemble it from the database on every tick.

let task: ScheduledTask | null = null;
let activeRun: JobRun | null = null;
let stopRequested = false;

// ── Step helpers ─────────────────────────────────────────────────────────────

/**
 * Age of the newest stored verdict across *all* flag combinations, or null when
 * the stock was never analysed.
 *
 * Deliberately combination-blind: the question the schedule asks is "does this
 * stock have a recent verdict?", not "has this exact model run recently?".
 * Keying it to the configured model would re-analyse the whole watchlist the
 * day someone switches models.
 */
async function newestAnalysisAgeDays(symbol: string): Promise<number | null> {
  const entries = await listAnalyses(symbol);
  if (entries.length === 0) return null;
  const newest = entries
    .map((e) => new Date(e.generatedAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  if (newest === undefined) return null;
  return (Date.now() - newest) / 86_400_000;
}

/**
 * The search providers to use for one symbol, escalated when the symbol has no
 * sell-side coverage.
 *
 * The nightly defaults are deliberately cheap: no search, no Perplexity. For a
 * covered stock that is fine — the analyst consensus is an independent check on
 * the computed models. For an uncovered one it is not: the models become the
 * only voice in the room, and any error in their shared inputs goes unchallenged
 * all the way to the verdict.
 *
 * Reads coverage from the stored financials, which the data step has just
 * refreshed. A missing or unreadable payload escalates too — not knowing whether
 * a symbol is covered is not a reason to assume it is.
 */
async function escalateSearchIfUncovered(config: AppConfig, symbol: string): Promise<string[]> {
  const { search, searchWhenUncovered, uncoveredSearchProvider } = config.steps.analysis;
  if (!searchWhenUncovered || search.length > 0) return search;

  let covered: boolean;
  try {
    const f = await readFinancialsLax(symbol);
    const ratings = (f?.analystStrongBuy ?? 0) + (f?.analystBuy ?? 0) + (f?.analystHold ?? 0)
      + (f?.analystSell ?? 0) + (f?.analystStrongSell ?? 0);
    covered = ratings > 0 || (f?.targetMeanPrice ?? null) !== null;
  } catch {
    covered = false;
  }
  if (covered) return search;

  logger.info(`${symbol}: no analyst coverage — escalating to search "${uncoveredSearchProvider}" for this symbol.`);
  return [uncoveredSearchProvider];
}

async function timed(fn: () => Promise<string>): Promise<{ detail: string; ms: number }> {
  const started = Date.now();
  const detail = await fn();
  return { detail, ms: Date.now() - started };
}

/** Run every enabled step for one symbol, in order, collecting per-step outcomes. */
async function processSymbol(
  config: AppConfig,
  symbol: string,
  runId: number,
): Promise<JobSymbolResult> {
  const cfg = getConfig();
  const startedAt = Date.now();
  const steps: JobStepResult[] = [];

  const record = (step: JobStep, status: StepStatus, detail: string, ms: number) =>
    steps.push({ step, status, detail, ms });

  // ── 1. Data ────────────────────────────────────────────────────────────────
  if (config.steps.data.enabled) {
    try {
      const { detail, ms } = await timed(async () => {
        // Distill is its own step below — skip the courtesy fetch inside the
        // data refresh so a symbol never hits Distill twice in one run.
        const data = await refreshStockData(symbol, { includeDistill: false, runId });
        return `$${data.financials.price.toFixed(2)} · ${data.news.length} news`;
      });
      record('data', 'ok', detail, ms);
    } catch (e) {
      record('data', 'failed', (e as Error).message, 0);
    }
  } else {
    record('data', 'skipped', 'step disabled', 0);
  }

  // ── 2. Distill ─────────────────────────────────────────────────────────────
  if (!config.steps.distill.enabled) {
    record('distill', 'skipped', 'step disabled', 0);
  } else if (!cfg.distillApiKey) {
    record('distill', 'skipped', 'DISTILL_API_KEY not set', 0);
  } else {
    try {
      const { detail, ms } = await timed(async () => {
        const financials = await readFinancialsLax(symbol);
        const result = await syncDistillBriefing(
          distillHintsFor(symbol, financials),
          cfg.distillApiKey!,
          cfg.distillApiUrl,
          cfg.distillBriefingTypeId,
          config.steps.distill.mode,
        );
        const state = result.cacheState ? `${result.cacheState}` : 'fetched';
        const cost = result.distillCostUsd > 0 ? ` · $${result.distillCostUsd.toFixed(4)}` : '';
        return `${result.mode}: ${state}${result.bundle.briefing ? '' : ', no briefing'}${cost}`;
      });
      record('distill', 'ok', detail, ms);
    } catch (e) {
      record('distill', 'failed', (e as Error).message, 0);
    }
  }

  // ── 3. Analysis (only when the verdict has aged out) ────────────────────────
  const analysis = config.steps.analysis;
  if (!analysis.enabled) {
    record('analysis', 'skipped', 'step disabled', 0);
  } else {
    const age = await newestAnalysisAgeDays(symbol);
    const stale = age === null || age > analysis.maxAgeDays;
    if (!stale) {
      record('analysis', 'skipped', `verdict is ${age!.toFixed(1)}d old (limit ${analysis.maxAgeDays}d)`, 0);
    } else {
      // With no sell-side coverage the verdict would rest entirely on our own
      // computed models — no consensus to triangulate against, and on the
      // shipped defaults no web context either. Spend one search call to buy
      // back an independent input rather than analyse in a closed loop.
      const search = await escalateSearchIfUncovered(config, symbol);

      try {
        const { detail, ms } = await timed(async () => {
          const { result } = await runAnalysis({
            symbol,
            model:  analysis.model,
            search,
            pplx:   analysis.pplx,
            runId,
            // A stored verdict has no TTL, so a plain run would serve the very
            // one we consider stale. Force means force.
            force:  true,
          });
          return `${result.llmAnalysis.recommendation} · score ${result.llmAnalysis.score}/10 · ${result.provider}`;
        });
        record('analysis', 'ok', `${age === null ? 'never analysed' : `${age.toFixed(1)}d old`} → ${detail}`, ms);
      } catch (e) {
        record('analysis', 'failed', (e as Error).message, 0);
      }
    }
  }

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

/** Symbols the nightly run covers, in the order it will walk them. */
export async function scheduledSymbols(config: AppConfig): Promise<string[]> {
  return (await listSymbols()).filter((s) => isWatched(config, s)).sort();
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
  return {
    cron:     task ? config.schedule.cron : null,
    timezone: config.schedule.timezone,
    nextRun:  next ? next.toISOString() : null,
    running:  activeRun !== null,
    // The in-memory run is ahead of the stored one mid-symbol; prefer it.
    current:  activeRun,
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
