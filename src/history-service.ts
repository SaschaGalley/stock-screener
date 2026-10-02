/**
 * The archive: what a refresh fetched, kept beyond the payload it fed.
 *
 * Best effort by design. Nothing in the analysis reads these tables yet, so a
 * failure here is logged and the refresh carries on — a day's archive lost is
 * a gap in a record, a refresh lost is a stale page.
 */

import { join } from 'path';

import { getConfig } from './config.js';
import { readAppState, writeAppState } from './db/admin.js';
import {
  priceCoverage, saveAnalystActions, saveInsiderTransactions, savePriceBars, savePriceEvents,
} from './db/history-store.js';
import { saveSnapshot } from './db/store.js';
import { BENCHMARK_TICKERS } from './data/macro.js';
import type { YahooRaw } from './data/yahoo-raw.js';
import { priceHistory, type PriceHistory } from './backtest/prices.js';
import { logger } from './utils/logger.js';

/** Bump when a raw snapshot's shape changes; older rows stay as they were stored. */
const RAW_VERSION = 1;
/** How far back the first refresh of a ticker reaches. */
const BACKFILL_YEARS = 10;
/** Fewer stored days than this and the long history has not been fetched yet. */
const BACKFILLED_DAYS = 2000;

const today = () => new Date().toISOString().slice(0, 10);

/** Everything a Yahoo fetch brought back that the payload does not carry. */
export async function archiveFetch(symbol: string, raw: YahooRaw, runId?: number | null): Promise<void> {
  try {
    await savePriceBars(symbol, raw.priceBars);
    await savePriceEvents(symbol, raw.priceEvents);
    // Snapshots dedupe by content: statements add a row a quarter, holders a
    // row per filing, the estimates most days.
    await saveSnapshot(symbol, 'yahoo_statements', RAW_VERSION, raw.statements, runId);
    if (Object.keys(raw.analyst).length > 0) await saveSnapshot(symbol, 'yahoo_analyst', RAW_VERSION, raw.analyst, runId);
    if (Object.keys(raw.holders).length > 0) await saveSnapshot(symbol, 'yahoo_holders', RAW_VERSION, raw.holders, runId);
    await saveAnalystActions(symbol, raw.analystActions);
    await saveInsiderTransactions(symbol, raw.insiderTransactions);
    await ensureLongPriceHistory(symbol);
    await refreshBenchmarks();
  } catch (e) {
    logger.warn(`${symbol}: archive incomplete — ${(e as Error).message}`);
  }
}

/** A daily history fetched for another purpose — the valuation history, a backtest — kept as well. */
export async function savePriceHistory(ticker: string, px: PriceHistory): Promise<void> {
  await savePriceBars(ticker, px.dates.map((day, k) => ({
    day, open: null, high: null, low: null, close: px.close[k], adjClose: px.adj[k], volume: null,
  })));
  await savePriceEvents(ticker, [
    ...px.splits.map((s) => ({ day: s.date, kind: 'split' as const, value: s.ratio })),
    ...(px.dividends ?? []).map((d) => ({ day: d.date, kind: 'dividend' as const, value: d.amount })),
  ]);
}

/**
 * Ten years of a ticker, once. The nightly refresh only fetches the last year;
 * the first time a ticker is seen, the decade before it is fetched too, so the
 * archive does not start on the day it was switched on. Tried once per ticker:
 * a listing younger than ten years would otherwise ask every night.
 */
async function ensureLongPriceHistory(ticker: string): Promise<void> {
  const key = `prices.backfill.${ticker.toUpperCase()}`;
  if (await readAppState(key)) return;
  if ((await priceCoverage(ticker)).days >= BACKFILLED_DAYS) {
    await writeAppState(key, today());
    return;
  }
  const from = `${Number(today().slice(0, 4)) - BACKFILL_YEARS}${today().slice(4)}`;
  const px = await priceHistory(ticker, from, join(getConfig().dataDir, 'backtest', 'prices'));
  if (px) {
    await savePriceHistory(ticker, px);
    logger.info(`${ticker}: price archive backfilled from ${px.dates[0]} (${px.dates.length} days)`);
  }
  await writeAppState(key, today());
}

/**
 * The index, the dollar and the sector ETFs, once a day per process. A refresh
 * touches a hundred stocks a night and every one of them is measured against
 * the same dozen series.
 */
let benchmarksDay: string | null = null;
async function refreshBenchmarks(): Promise<void> {
  if (benchmarksDay === today()) return;
  benchmarksDay = today();
  const dir = join(getConfig().dataDir, 'backtest', 'prices');
  for (const ticker of BENCHMARK_TICKERS) {
    const coverage = await priceCoverage(ticker);
    const years = coverage.days >= BACKFILLED_DAYS ? 1 : BACKFILL_YEARS;
    const from = `${Number(today().slice(0, 4)) - years}${today().slice(4)}`;
    const px = await priceHistory(ticker, from, dir, 1);
    if (px) await savePriceHistory(ticker, px);
  }
}
