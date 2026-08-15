/**
 * The nightly pipeline: one cron, one queue, one symbol at a time.
 *
 * Serial on purpose. Every step here talks to a rate-limited third party
 * (Yahoo, Finnhub, Distill, an LLM) and writes into the same per-symbol cache
 * directory; running symbols in parallel would multiply the ways those two
 * facts can collide for a run that has all night to finish anyway. The only
 * concurrency control needed is therefore "is a run active?" — a second
 * trigger, cron or manual, is refused rather than queued, because two runs of
 * the same pipeline would do the same work twice.
 *
 * Per symbol, in order:
 *   1. data     — Yahoo/Finnhub/FRED/macro refresh + technicals (writes history)
 *   2. distill  — refresh (POST, generates briefings) or fetch (GET, free)
 *   3. analysis — only when the newest verdict is older than `maxAgeDays`,
 *                 forced past the LLM cache so it produces an actual new one
 *
 * Runs are recorded to `$CACHE_DIR/job-runs.json` so the admin page can show
 * what happened last night after a restart.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import cron, { type ScheduledTask } from 'node-cron';

import { getConfig } from './config.js';
import { logger } from './utils/logger.js';
import { AppConfig, isWatched, readAppConfig } from './app-config.js';
import { listAnalyses, listCachedSymbols, readFinancialsLax } from './cache.js';
import { refreshStockData } from './refresh.js';
import { runAnalysis } from './cli.js';
import { distillHintsFor, syncDistillBriefing } from './distill-service.js';

export type JobStep = 'data' | 'distill' | 'analysis';
export type StepStatus = 'ok' | 'skipped' | 'failed';

export interface JobStepResult {
  step:   JobStep;
  status: StepStatus;
  /** One line of human-readable outcome ("still-current, $0.0000", "3d old"). */
  detail: string;
  ms:     number;
}

export interface JobSymbolResult {
  symbol: string;
  steps:  JobStepResult[];
  ms:     number;
}

export type JobRunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'stopped';

export interface JobRun {
  id:         string;
  trigger:    'cron' | 'manual';
  startedAt:  string;
  finishedAt: string | null;
  status:     JobRunStatus;
  /** Symbol currently being worked on, while status is 'running'. */
  currentSymbol: string | null;
  symbols:    JobSymbolResult[];
  totals:     { symbols: number; data: number; distill: number; analysis: number; failed: number };
  /** Set when the run itself (not a single step) blew up. */
  error?:     string;
}

const MAX_KEPT_RUNS = 20;

// ── Module state ─────────────────────────────────────────────────────────────
// A single active run and a single installed cron task. Both are per-process,
// which is exactly right for the single-container deployment this ships as.

let task: ScheduledTask | null = null;
let activeRun: JobRun | null = null;
let stopRequested = false;

function resolveCacheRoot(rawDir: string): string {
  if (rawDir.startsWith('~')) return join(homedir(), rawDir.slice(1));
  if (isAbsolute(rawDir)) return rawDir;
  return resolve(process.cwd(), rawDir);
}

function runsFile(cacheDir: string): string {
  return join(resolveCacheRoot(cacheDir), 'job-runs.json');
}

export function readJobRuns(cacheDir: string): JobRun[] {
  const file = runsFile(cacheDir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { runs?: JobRun[] };
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

function persistRun(cacheDir: string, run: JobRun): void {
  try {
    const root = resolveCacheRoot(cacheDir);
    mkdirSync(root, { recursive: true });
    const runs = readJobRuns(cacheDir).filter((r) => r.id !== run.id);
    runs.unshift(run);
    const file = runsFile(cacheDir);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ runs: runs.slice(0, MAX_KEPT_RUNS) }, null, 2), 'utf-8');
    renameSync(tmp, file);
  } catch (e) {
    logger.warn(`Could not persist job run: ${(e as Error).message}`);
  }
}

// ── Step helpers ─────────────────────────────────────────────────────────────

function ageInDays(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

/**
 * Age of the newest cached verdict across *all* flag combinations, or null when
 * the stock was never analysed.
 *
 * Deliberately combination-blind: the question the schedule asks is "does this
 * stock have a recent verdict?", not "has this exact model run recently?".
 * Keying it to the configured model would re-analyse the whole watchlist the
 * day someone switches models.
 */
function newestAnalysisAgeDays(cacheDir: string, symbol: string): number | null {
  const entries = listAnalyses(cacheDir, symbol);
  if (entries.length === 0) return null;
  const newest = entries
    .map((e) => new Date(e.generatedAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  if (newest === undefined) return null;
  return (Date.now() - newest) / 86_400_000;
}

async function timed(fn: () => Promise<string>): Promise<{ detail: string; ms: number }> {
  const started = Date.now();
  const detail = await fn();
  return { detail, ms: Date.now() - started };
}

/** Run every enabled step for one symbol, in order, collecting per-step outcomes. */
async function processSymbol(
  cacheDir: string,
  config: AppConfig,
  symbol: string,
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
        const data = await refreshStockData(symbol, { includeDistill: false });
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
        const financials = readFinancialsLax(cacheDir, symbol);
        const result = await syncDistillBriefing(
          cacheDir,
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
    const age = newestAnalysisAgeDays(cacheDir, symbol);
    const stale = age === null || age > analysis.maxAgeDays;
    if (!stale) {
      record('analysis', 'skipped', `verdict is ${age!.toFixed(1)}d old (limit ${analysis.maxAgeDays}d)`, 0);
    } else {
      try {
        const { detail, ms } = await timed(async () => {
          const { result } = await runAnalysis({
            symbol,
            model:  analysis.model,
            search: analysis.search,
            pplx:   analysis.pplx,
            // The LLM cache is hash-keyed with no TTL, so a plain run would
            // serve the very verdict we consider stale. Force means force.
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

  return { symbol, steps, ms: Date.now() - startedAt };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface RunOptions {
  trigger: 'cron' | 'manual';
  /** Explicit subset; defaults to every watched symbol with cached financials. */
  symbols?: string[];
}

export class JobBusyError extends Error {
  constructor() {
    super('A pipeline run is already in progress.');
    this.name = 'JobBusyError';
  }
}

/** Symbols the nightly run covers, in the order it will walk them. */
export function scheduledSymbols(cacheDir: string, config: AppConfig): string[] {
  return listCachedSymbols(cacheDir)
    .filter((s) => isWatched(config, s))
    .sort();
}

/**
 * Walk the watchlist serially. Resolves with the finished run; step failures
 * are recorded per symbol and never abort the rest of the list — one dead
 * ticker must not cost the other forty their nightly update.
 */
export async function runPipeline(opts: RunOptions): Promise<JobRun> {
  if (activeRun) throw new JobBusyError();

  const cacheDir = getConfig().cacheDir;
  const config = readAppConfig(cacheDir);
  const symbols = opts.symbols?.length
    ? opts.symbols.map((s) => s.toUpperCase())
    : scheduledSymbols(cacheDir, config);

  const run: JobRun = {
    id:            new Date().toISOString(),
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
  persistRun(cacheDir, run);

  logger.info(`Pipeline run started (${opts.trigger}) — ${symbols.length} symbol(s)`);

  try {
    for (const symbol of symbols) {
      if (stopRequested) {
        run.status = 'stopped';
        break;
      }
      run.currentSymbol = symbol;
      const result = await processSymbol(cacheDir, config, symbol);
      run.symbols.push(result);
      for (const step of result.steps) {
        if (step.status === 'ok') run.totals[step.step]++;
        if (step.status === 'failed') run.totals.failed++;
      }
      // Persist after every symbol: a container restart mid-run should still
      // leave a truthful record of how far it got.
      persistRun(cacheDir, run);
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
    persistRun(cacheDir, run);
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

export function getSchedulerStatus(cacheDir: string): SchedulerStatus {
  const config = readAppConfig(cacheDir);
  const next = task?.getNextRun() ?? null;
  return {
    cron:     task ? config.schedule.cron : null,
    timezone: config.schedule.timezone,
    nextRun:  next ? next.toISOString() : null,
    running:  activeRun !== null,
    current:  activeRun,
    runs:     readJobRuns(cacheDir),
    watched:  scheduledSymbols(cacheDir, config),
  };
}

/**
 * Install (or remove) the cron task for the current config. Idempotent — call
 * it at boot and again after every config change.
 */
export function applySchedule(cacheDir: string): void {
  if (task) {
    task.destroy();
    task = null;
  }

  const config = readAppConfig(cacheDir);
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
