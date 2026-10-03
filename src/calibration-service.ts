/**
 * The calibration as a deployment runs it: from the admin page.
 *
 * `pnpm run calibrate` writes a source file, which is right for a checkout and
 * impossible in the image — it has neither the sources nor pnpm, and a file
 * written there would vanish with the container. Yet the database with the
 * universe in it is the deployment's. So the page starts the same script with
 * `--store` in a child process, as it starts the backtest, and the script
 * leaves the table in the database as a proposal. The page offers it as the
 * file to commit: a calibration stays a code change, reviewed and re-scored
 * like any other, and the deploy that carries it re-scores the history.
 */

import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import { getConfig } from './config.js';
import { readAppState, writeAppState } from './db/admin.js';
import { PROPOSAL_KEY, STATUS_KEY, type CalibrationProposal, type CalibrationStatus } from './db/calibrate.js';
import { logger } from './utils/logger.js';

let child: ReturnType<typeof spawn> | null = null;

/** The script beside this module: `.ts` under tsx in development, `.js` from `dist` in production. */
const RUNNER = fileURLToPath(new URL(`./db/calibrate${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url));

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await readAppState(key);
  return raw ? JSON.parse(raw) as T : null;
}

/** Start a calibration unless one is going. */
export async function startCalibration(): Promise<{ started: boolean; reason: string | null }> {
  if (child) return { started: false, reason: 'Es läuft bereits eine Kalibrierung' };
  const dir = join(getConfig().dataDir, 'calibration');
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, 'run.log');
  const out = openSync(logFile, 'w');
  child = spawn(process.execPath, [...process.execArgv, RUNNER, '--store'], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', out, out],
  });
  closeSync(out);
  const startedAt = new Date().toISOString();
  child.on('exit', (code) => {
    child = null;
    if (code === 0) return;
    // Killed, or crashed before it could say so.
    void writeAppState(STATUS_KEY, JSON.stringify({
      state: 'failed', startedAt, finishedAt: new Date().toISOString(), error: `Prozess beendet mit Code ${code}`,
    } satisfies CalibrationStatus)).catch(() => { /* nothing more to do */ });
  });
  logger.info(`Calibration started — log in ${logFile}`);
  return { started: true, reason: null };
}

/** The newest proposal, without its file — what the page shows. */
export type ProposalSummary = Omit<CalibrationProposal, 'source'>;

export interface CalibrationOverview {
  status:   CalibrationStatus | null;
  running:  boolean;
  proposal: ProposalSummary | null;
}

export async function calibrationOverview(): Promise<CalibrationOverview> {
  let status = await readJson<CalibrationStatus>(STATUS_KEY);
  // A run still `running` with no process behind it died with the server.
  if (status?.state === 'running' && !child) {
    status = { ...status, state: 'interrupted', finishedAt: status.finishedAt ?? new Date().toISOString() };
    await writeAppState(STATUS_KEY, JSON.stringify(status));
  }
  const proposal = await readJson<CalibrationProposal>(PROPOSAL_KEY);
  const { source: _source, ...summary } = proposal ?? { source: '' };
  return { status, running: !!child, proposal: proposal ? summary as ProposalSummary : null };
}

/** The proposed file, for download. */
export async function proposedTable(): Promise<string | null> {
  return (await readJson<CalibrationProposal>(PROPOSAL_KEY))?.source ?? null;
}
