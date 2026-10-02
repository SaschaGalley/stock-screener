/**
 * Cached access to a stock's rebuilt valuation history.
 *
 * Same split as `perplexity-service.ts`: `backtest/history.ts` does the work,
 * `db/store.ts` the persistence, and the policy that joins them sits here. The
 * work is a SEC download, two price histories and sixty runs of the models —
 * a few seconds the first time a stock is opened, and nothing worth repeating
 * within a day: a month-end comes once a month and a filing once a quarter.
 */

import { getConfig } from './config.js';
import { reconstructHistory } from './backtest/history.js';
import type { ValuationHistory } from './analysis/valuation-history.js';
import { latestSnapshot, readFinancialsLax, saveSnapshot } from './db/store.js';
import { logger } from './utils/logger.js';

/** Bump when the shape or the reconstruction changes; older rows are rebuilt. */
export const VALUATION_HISTORY_VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One rebuild per symbol at a time — a page opened twice should not pay twice. */
const inFlight = new Map<string, Promise<ValuationHistory | null>>();

export async function getValuationHistory(symbol: string): Promise<ValuationHistory | null> {
  const stored = await latestSnapshot<ValuationHistory>(symbol, 'valuation_history', {
    schemaVer: VALUATION_HISTORY_VERSION, maxAgeMs: MAX_AGE_MS,
  });
  if (stored && !stored.stale) return stored.data;

  const running = inFlight.get(symbol);
  if (running) return running;
  const job = rebuild(symbol).finally(() => inFlight.delete(symbol));
  inFlight.set(symbol, job);
  return job;
}

async function rebuild(symbol: string): Promise<ValuationHistory | null> {
  // Lax: the history needs the name, sector and annual figures, none of which a
  // stale snapshot gets wrong enough to matter.
  const financials = await readFinancialsLax(symbol);
  if (!financials) return null;
  const cfg = getConfig();
  const started = Date.now();
  const history = await reconstructHistory({ financials, dataDir: cfg.dataDir, fredApiKey: cfg.fredApiKey });
  if (!history) return null;
  logger.info(`${symbol}: valuation history rebuilt from ${history.source} — ${history.points.length} months in ${Date.now() - started} ms`);
  await saveSnapshot(symbol, 'valuation_history', VALUATION_HISTORY_VERSION, history);
  return history;
}
