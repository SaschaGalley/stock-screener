/**
 * A fund's largest holdings and sector split, from Yahoo's `topHoldings`
 * (`analysis/look-through.ts` reads them). Yahoo has them for the UCITS
 * listings too: the ten largest positions with their share of the fund, the
 * sector split of its equity part, and how much of it is shares, bonds and cash.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import YahooFinance from 'yahoo-finance2';

import type { FundHoldings } from '../analysis/look-through.js';
import { SECTOR_ETFS } from './macro.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false, logOptionsErrors: false } } as any);

/** Yahoo's keys — `realestate`, `consumer_cyclical` — to the sector names the stocks carry. */
const SECTOR_BY_KEY = new Map(SECTOR_ETFS.map((s) => [s.sector.toLowerCase().replace(/[^a-z]/g, ''), s.sector]));

const share = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : typeof v === 'object' && v && 'raw' in v ? Number((v as { raw: unknown }).raw) : NaN;
  return Number.isFinite(x) ? x : null;
};

/** The holdings from Yahoo's module as it comes; null when it describes no fund. */
export function parseTopHoldings(symbol: string, th: any, asOf = new Date().toISOString()): FundHoldings | null {
  if (!th || typeof th !== 'object') return null;
  const holdings = (Array.isArray(th.holdings) ? th.holdings : []).flatMap((h: any) => {
    const weight = share(h?.holdingPercent);
    const name = typeof h?.holdingName === 'string' ? h.holdingName.trim() : '';
    return weight !== null && weight > 0 && name ? [{ symbol: typeof h.symbol === 'string' && h.symbol ? h.symbol : null, name, weight }] : [];
  });
  const sectors = (Array.isArray(th.sectorWeightings) ? th.sectorWeightings : []).flatMap((o: any) =>
    Object.entries(o ?? {}).flatMap(([k, v]) => {
      const sector = SECTOR_BY_KEY.get(k.toLowerCase().replace(/[^a-z]/g, ''));
      const weight = share(v);
      return sector && weight !== null && weight > 0 ? [{ sector, weight }] : [];
    }));
  if (holdings.length === 0 && sectors.length === 0) return null;
  return { symbol, asOf, holdings, full: null, sectors, equity: share(th.stockPosition), bonds: share(th.bondPosition), cash: share(th.cashPosition) };
}

/** Fetch a fund's holdings: the module as Yahoo sent it, to keep, and what it says. */
export async function fetchFundHoldings(symbol: string): Promise<{ raw: unknown; holdings: FundHoldings | null }> {
  const r: any = await yf.quoteSummary(symbol, { modules: ['topHoldings'] } as any, { validateResult: false } as any);
  return { raw: r?.topHoldings ?? null, holdings: parseTopHoldings(symbol, r?.topHoldings) };
}
