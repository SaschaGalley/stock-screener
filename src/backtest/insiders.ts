/**
 * Every company's insider transactions, for the backtest's candidate signals.
 *
 * One Finnhub request per company returns its whole Form 4 history; at the
 * free tier's minute window the index takes half an hour the first time, so
 * the answers are cached on disk for a month — a filing from 2015 does not
 * change. Archived as a snapshot (`finnhub_insider`) for the companies the app
 * already knows, and only for those, as with the rating history (`analysts.ts`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { getInsiderTransactions, type FinnhubInsiderTrade } from '../data/finnhub.js';
import { saveSnapshot, symbolId } from '../db/store.js';
import { logger } from '../utils/logger.js';

const CACHE_DAYS = 30;
const RAW_VERSION = 1;

export async function insiderHistory(
  symbol: string, apiKey: string, cacheDir: string, maxAgeDays = CACHE_DAYS,
): Promise<FinnhubInsiderTrade[] | null> {
  const file = join(cacheDir, `${symbol.replace(/[^A-Za-z0-9.^-]/g, '_')}.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: string; trades: FinnhubInsiderTrade[] };
      if (Date.now() - Date.parse(cached.fetchedAt) < maxAgeDays * 86_400_000) return cached.trades;
    } catch { /* fetch again */ }
  }
  try {
    const trades = (await getInsiderTransactions(symbol, apiKey))
      .sort((a, b) => a.filingDate.localeCompare(b.filingDate));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), trades }));
    if (await symbolId(symbol).catch(() => null) !== null) {
      await saveSnapshot(symbol, 'finnhub_insider', RAW_VERSION, trades)
        .catch((e) => logger.debug(`Insider archive ${symbol}: ${(e as Error).message}`));
    }
    return trades;
  } catch (e) {
    logger.warn(`Insider history ${symbol}: ${(e as Error).message}`);
    return null;
  }
}
