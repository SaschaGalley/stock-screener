/**
 * Every rating action Yahoo lists for a company, for the backtest.
 *
 * The live refresh archives the history for the stocks it follows; the
 * backtest needs it for the whole index. Fetched once a week per company and
 * cached on disk like the prices, and stored in the archive too
 * (`analyst_actions`), where it outlives Yahoo's own list.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { logger } from '../utils/logger.js';
import { analystActionsFrom } from '../data/yahoo-raw.js';
import { saveAnalystActions } from '../db/history-store.js';
import type { AnalystAction } from '../analysis/analyst-accuracy.js';
import { yahooWindow, yf } from './prices.js';

const CACHE_DAYS = 7;

export async function analystHistory(symbol: string, cacheDir: string, maxAgeDays = CACHE_DAYS): Promise<AnalystAction[] | null> {
  const file = join(cacheDir, `${symbol.replace(/[^A-Za-z0-9.^-]/g, '_')}.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: string; actions: AnalystAction[] };
      if (Date.now() - Date.parse(cached.fetchedAt) < maxAgeDays * 86_400_000) return cached.actions;
    } catch { /* fetch again */ }
  }
  try {
    await yahooWindow.take();
    // Unvalidated, as the live archive asks for it: a shape the library does
    // not expect must not cost the history.
    const r = await yf.quoteSummary(symbol, { modules: ['upgradeDowngradeHistory'] }, { validateResult: false });
    const actions = analystActionsFrom(r?.upgradeDowngradeHistory);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), actions }));
    await saveAnalystActions(symbol, actions).catch((e) => logger.debug(`Analyst archive ${symbol}: ${(e as Error).message}`));
    return actions;
  } catch (e) {
    logger.warn(`Analyst history ${symbol}: ${(e as Error).message}`);
    return null;
  }
}
