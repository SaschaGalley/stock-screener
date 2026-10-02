/**
 * One backtest at a time, across every process.
 *
 * A run takes a quarter of an hour on a warm cache and an hour on a cold one,
 * holds the S&P 1500 in memory and spends Yahoo's, the SEC's and Finnhub's
 * budgets. A second one started beside it — the monthly schedule firing while
 * someone pressed the button, or a run from the terminal — would double all
 * of that and finish with the same answer. Postgres's advisory lock is held
 * by the connection that took it, so it ends with the process even when the
 * process ends badly, and no stale flag needs clearing.
 */

import { getPool } from '../db/client.js';

/** A number of our own for the advisory lock: "BTST". */
const LOCK_KEY = 0x42545354;

export interface BacktestLock { release(): Promise<void> }

/** The lock, held until released — or null when another run has it. */
export async function takeBacktestLock(): Promise<BacktestLock | null> {
  const client = await getPool().connect();
  const r = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
  if (!r.rows[0]?.ok) {
    client.release();
    return null;
  }
  return {
    release: async () => {
      try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } finally { client.release(); }
    },
  };
}

/** Whether some process is running a backtest right now. */
export async function backtestRunning(): Promise<boolean> {
  const lock = await takeBacktestLock();
  if (!lock) return true;
  await lock.release();
  return false;
}
