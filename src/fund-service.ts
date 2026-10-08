/**
 * The funds' holdings for the depot's look-through: the stored answer while it
 * is less than a week old, else Yahoo's, kept. A fund Yahoo cannot describe is
 * left out and the page says so; a failed fetch falls back to an older answer.
 */

import type { FundHoldings } from './analysis/look-through.js';
import { fetchFundHoldings, parseTopHoldings } from './data/fund-holdings.js';
import { latestFundHoldings, saveFundHoldings } from './db/fund-store.js';
import { logger } from './utils/logger.js';

/** A fund's ten largest positions move slowly: a week-old answer is today's. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function fundHoldings(symbols: readonly string[]): Promise<Map<string, FundHoldings>> {
  const stored = await latestFundHoldings(symbols);
  const out = new Map<string, FundHoldings>();
  await Promise.all(symbols.map(async (symbol) => {
    const s = stored.get(symbol);
    if (s && Date.now() - s.seenAt.getTime() < MAX_AGE_MS) {
      const h = parseTopHoldings(symbol, s.raw, s.seenAt.toISOString());
      if (h) out.set(symbol, h);
      return;
    }
    try {
      const { raw, holdings } = await fetchFundHoldings(symbol);
      if (raw) await saveFundHoldings(symbol, raw);
      if (holdings) { out.set(symbol, holdings); return; }
    } catch (e) {
      logger.warn(`Fund holdings ${symbol}: ${(e as Error).message}`);
    }
    const old = s ? parseTopHoldings(symbol, s.raw, s.seenAt.toISOString()) : null;
    if (old) out.set(symbol, old);
  }));
  return out;
}
