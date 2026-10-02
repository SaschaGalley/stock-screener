/**
 * Daily price histories for the backtest, with the splits between then and now.
 *
 * Yahoo's `close` is already adjusted for splits and `adjclose` for dividends
 * as well. The first is the price a market capitalisation is built from — a
 * split-adjusted price times a split-adjusted share count — and the second is
 * what a holder earned. A share count from a 2014 filing is on 2014's basis,
 * so the splits are kept to bring it onto today's (`splitFactorAfter`).
 *
 * Histories are cached on disk: several hundred of them, a dozen years each,
 * are not worth fetching again for every run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import YahooFinance from 'yahoo-finance2';

import { logger } from '../utils/logger.js';
import { RateWindow } from '../utils/rate-window.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const yf = new (YahooFinance as any)({ suppressNotices: ['yahooSurvey', 'ripHistorical'], validation: { logErrors: false } });

export interface PriceHistory {
  /** Trading days, YYYY-MM-DD, oldest first. */
  dates: string[];
  /** Split-adjusted closes. */
  close: number[];
  /** Split- and dividend-adjusted closes: what a holder earned. */
  adj:   number[];
  /** Splits, with the ratio of new shares to old. */
  splits: { date: string; ratio: number }[];
  /** Dividends per share. Absent in cache files written before they were asked for. */
  dividends?: { date: string; amount: number }[];
}

const CACHE_DAYS = 7;

/**
 * Two histories a second. Several hundred at once would be the burst Yahoo
 * answers with a block, and the nightly refresh shares the same address.
 */
const yahooWindow = new RateWindow(2, 1000);

export async function priceHistory(
  symbol: string, from: string, cacheDir: string, maxAgeDays = CACHE_DAYS,
): Promise<PriceHistory | null> {
  const file = join(cacheDir, `${symbol.replace(/[^A-Za-z0-9.^-]/g, '_')}.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as PriceHistory & { fetchedAt: string; from: string };
      if (cached.from <= from && Date.now() - Date.parse(cached.fetchedAt) < maxAgeDays * 86_400_000) return cached;
    } catch { /* fetch again */ }
  }
  try {
    await yahooWindow.take();
    const r = await yf.chart(symbol, { period1: from, interval: '1d', events: 'div|split' });
    const out: PriceHistory = { dates: [], close: [], adj: [], splits: [], dividends: [] };
    for (const q of r?.quotes ?? []) {
      const close = typeof q.close === 'number' && Number.isFinite(q.close) ? q.close : null;
      if (close === null || close <= 0) continue;
      const adj = typeof q.adjclose === 'number' && Number.isFinite(q.adjclose) && q.adjclose > 0 ? q.adjclose : close;
      const d = q.date instanceof Date ? q.date : new Date(q.date);
      out.dates.push(d.toISOString().slice(0, 10));
      out.close.push(close);
      out.adj.push(adj);
    }
    for (const s of r?.events?.splits ?? []) {
      const ratio = Number(s.numerator) / Number(s.denominator);
      if (Number.isFinite(ratio) && ratio > 0) {
        const d = s.date instanceof Date ? s.date : new Date(s.date);
        out.splits.push({ date: d.toISOString().slice(0, 10), ratio });
      }
    }
    out.splits.sort((a, b) => a.date.localeCompare(b.date));
    for (const dv of r?.events?.dividends ?? []) {
      const amount = Number(dv.amount);
      if (Number.isFinite(amount) && amount > 0) {
        const d = dv.date instanceof Date ? dv.date : new Date(dv.date);
        out.dividends!.push({ date: d.toISOString().slice(0, 10), amount });
      }
    }
    if (out.dates.length === 0) return null;
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ ...out, from, fetchedAt: new Date().toISOString() }));
    return out;
  } catch (e) {
    logger.warn(`Price history ${symbol}: ${(e as Error).message}`);
    return null;
  }
}

/** Index of the last trading day at or before `date`, or −1. */
export function indexAtOrBefore(dates: string[], date: string): number {
  let lo = 0, hi = dates.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** The last trading day of every month between `from` and `to`. */
export function monthEnds(dates: string[], from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = 0; k < dates.length; k++) {
    const d = dates[k];
    if (d < from || d > to) continue;
    const next = dates[k + 1];
    if (!next || next.slice(0, 7) !== d.slice(0, 7)) out.push(d);
  }
  return out;
}

/**
 * How many of today's shares one share on `date` has become: the product of
 * every split after it. A share count reported then, times this, is on the
 * basis today's split-adjusted prices are on.
 */
export function splitFactorAfter(splits: PriceHistory['splits'], date: string): number {
  let f = 1;
  for (const s of splits) if (s.date > date) f *= s.ratio;
  return f;
}
