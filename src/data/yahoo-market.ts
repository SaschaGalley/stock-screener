/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Yahoo's market-wide lists: the predefined screens (the day's gainers, the
 * most traded, the undervalued large caps …), the trending tickers, and
 * quotes for many tickers at once. Unvalidated: the lists are kept as they
 * come (`market_lists`), and a field the library does not expect must not
 * cost the list.
 */

import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false, logOptionsErrors: false } } as any);
const RAW = { validateResult: false } as any;

/** Tickers per quote request; Yahoo answers a few hundred, but a long URL is the first thing a proxy refuses. */
const QUOTE_CHUNK = 150;

/** One predefined screen's quotes, as Yahoo sends them. */
export async function screenerQuotes(id: string, count: number): Promise<Record<string, unknown>[]> {
  const r: any = await yf.screener({ scrIds: id as any, count }, undefined, RAW);
  return Array.isArray(r?.quotes) ? r.quotes : [];
}

/** The tickers trending on Yahoo in a region, most viewed first. */
export async function trendingTickers(region: string, count: number): Promise<string[]> {
  const r: any = await yf.trendingSymbols(region, { count } as any, RAW);
  return (Array.isArray(r?.quotes) ? r.quotes : [])
    .map((q: any) => (typeof q?.symbol === 'string' ? q.symbol : null))
    .filter((s: string | null): s is string => !!s);
}

/** Quotes for many tickers, in chunks; a chunk that fails leaves its tickers out rather than failing the rest. */
export async function quotesFor(symbols: readonly string[]): Promise<Record<string, unknown>[]> {
  const chunks: string[][] = [];
  for (let k = 0; k < symbols.length; k += QUOTE_CHUNK) chunks.push(symbols.slice(k, k + QUOTE_CHUNK));
  const answers = await Promise.all(chunks.map(async (chunk) => {
    try {
      const r: any = await yf.quote(chunk, { return: 'array' } as any, RAW);
      return Array.isArray(r) ? r : [];
    } catch {
      return [];
    }
  }));
  return answers.flat();
}
