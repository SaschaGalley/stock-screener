/**
 * The backtest as the server runs it: once a month on its own, or when the
 * admin page asks.
 *
 * The run is a child process — `backtest/run.ts` as the terminal runs it —
 * not a function call in the server. It holds the S&P 1500 in memory for up
 * to an hour, and a server that answers the page must not share its heap with
 * that, nor go down if it does. The child takes the advisory lock
 * (`backtest/lock.ts`), writes its own progress (`backtest.status`) and its own
 * log (`backtest/run.log` under the data directory): a pipe to the server
 * would break when the server restarts, and take the run with it.
 *
 * Scheduled in-process with node-cron, whichever scheduler owns the nightly
 * run: the backtest is one process a month, not a queue of stages. An
 * environment that leaves the nightly cron to production
 * (`HATCHET_SCHEDULE_ENABLED=false`) leaves this one to it as well.
 */

import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import cron, { type ScheduledTask } from 'node-cron';

import { readAppConfig } from './app-config.js';
import { getConfig } from './config.js';
import { isHatchetConfigured } from './hatchet/client.js';
import { backtestRunning } from './backtest/lock.js';
import {
  backtestHistory, readBacktestStatus, writeBacktestStatus,
  type BacktestRunSummary, type BacktestStatus, type BacktestTrigger,
} from './backtest/result.js';
import { logger } from './utils/logger.js';

/** The run's heap ceiling, in megabytes; `BACKTEST_HEAP_MB` overrides it. Below two gigabytes the S&P 1500 does not fit. */
const DEFAULT_HEAP_MB = 3072;

let task: ScheduledTask | null = null;
let child: ReturnType<typeof spawn> | null = null;

/** The runner beside this module: `.ts` under tsx in development, `.js` from `dist` in production. */
const RUNNER = fileURLToPath(new URL(`./backtest/run${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url));

/** Start a run unless one is going; says why not when it does not. */
export async function startBacktest(trigger: BacktestTrigger): Promise<{ started: boolean; reason: string | null }> {
  if (child || await backtestRunning()) return { started: false, reason: 'Es läuft bereits ein Backtest' };
  const dir = join(getConfig().dataDir, 'backtest');
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, 'run.log');
  const out = openSync(logFile, 'w');
  // The same Node, with the same loader flags: under tsx those are what make a
  // `.ts` runnable. And a ceiling on its heap: V8 grows into whatever the host
  // has, and a run that needs about two and a half gigabytes peaked anywhere
  // from 2.6 to 3.3 depending on when it collected. Held to a number, it
  // collects sooner and the host knows what to keep free.
  const heapMb = Number(process.env.BACKTEST_HEAP_MB ?? DEFAULT_HEAP_MB);
  child = spawn(process.execPath, [...process.execArgv, `--max-old-space-size=${heapMb}`, RUNNER, '--trigger', trigger], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', out, out],
  });
  closeSync(out);
  const startedAt = new Date().toISOString();
  child.on('exit', (code) => {
    child = null;
    if (code === 0 || code === 2) return;
    // Killed, or crashed before it could say so: the status still reads `running`.
    void readBacktestStatus().then((s) => {
      if (s?.state !== 'running' || s.startedAt < startedAt) return;
      return writeBacktestStatus({
        ...s, state: 'failed', finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        error: s.error ?? `Prozess beendet mit Code ${code}`,
      });
    }).catch(() => { /* nothing more to do */ });
  });
  logger.info(`Backtest started (${trigger}) — log in ${logFile}`);
  return { started: true, reason: null };
}

/**
 * A status still `running` with no run holding the lock is a run that died
 * with its process — a deploy, a restart. Said so, rather than left running.
 */
export async function reconcileBacktestStatus(): Promise<void> {
  const s = await readBacktestStatus();
  if (s?.state !== 'running' || child || await backtestRunning()) return;
  await writeBacktestStatus({ ...s, state: 'interrupted', finishedAt: s.updatedAt, updatedAt: new Date().toISOString() });
}

/** Install (or remove) the monthly run for the current config. Call at boot and after every config change. */
export async function applyBacktestSchedule(): Promise<void> {
  task?.destroy();
  task = null;
  const config = await readAppConfig();
  if (isHatchetConfigured() && !getConfig().hatchetScheduleEnabled) {
    logger.info('HATCHET_SCHEDULE_ENABLED=false — leaving the monthly backtest to production.');
    return;
  }
  if (!config.backtest.enabled) return;
  if (!cron.validate(config.backtest.cron)) {
    logger.error(`Invalid backtest cron "${config.backtest.cron}" — not scheduled.`);
    return;
  }
  task = cron.schedule(config.backtest.cron, () => {
    void startBacktest('cron').catch((e) => logger.error(`Scheduled backtest failed to start: ${(e as Error).message}`));
  }, { timezone: config.schedule.timezone, name: 'stock-backtest' });
  const next = task.getNextRun();
  logger.info(`Backtest scheduled: "${config.backtest.cron}" (${config.schedule.timezone})${next ? ` — next ${next.toISOString()}` : ''}`);
}

export interface BacktestOverview {
  status:   BacktestStatus | null;
  running:  boolean;
  schedule: { enabled: boolean; cron: string; timezone: string; next: string | null };
  runs:     BacktestRunSummary[];
}

export async function backtestOverview(): Promise<BacktestOverview> {
  // Asked of the lock, not only of the status: a run that died says nothing.
  await reconcileBacktestStatus().catch(() => { /* the status as it is, then */ });
  const [config, status, runs] = await Promise.all([readAppConfig(), readBacktestStatus(), backtestHistory()]);
  return {
    status,
    running: !!child || status?.state === 'running',
    schedule: {
      enabled: config.backtest.enabled, cron: config.backtest.cron, timezone: config.schedule.timezone,
      next: task?.getNextRun()?.toISOString() ?? null,
    },
    runs,
  };
}
