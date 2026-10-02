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
  lastMacroDay, priceCoverage, quoteCurrencies, saveAnalystActions, saveInsiderTransactions, saveMacroSeries, savePriceBars,
  savePriceEvents,
} from './db/history-store.js';
import { getImpliedERPSeries } from './data/damodaran.js';
import { fetchSeriesSince, READ_FRED_SERIES } from './data/fred.js';
import { saveSnapshot } from './db/store.js';
import { BENCHMARK_CURRENCY, BENCHMARK_TICKERS } from './data/macro.js';
import { fxTicker, majorCurrency } from './currencies.js';
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

/** Finnhub's `/stock/metric` as received, split by how often each half changes. */
export interface FinnhubArchive {
  /** Today's 130-odd ratios — new most days, a few kilobytes. */
  metric: Record<string, unknown> | null;
  /** Two decades of annual and quarterly ratios — new once a quarter, a quarter of a megabyte. */
  series: Record<string, unknown> | null;
}

/** Everything a fetch brought back that the payload does not carry. */
export async function archiveFetch(
  symbol: string, raw: YahooRaw, runId?: number | null, finnhub?: FinnhubArchive | null,
): Promise<void> {
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
    if (finnhub?.metric) await saveSnapshot(symbol, 'finnhub_metric', RAW_VERSION, finnhub.metric, runId);
    if (finnhub?.series) await saveSnapshot(symbol, 'finnhub_series', RAW_VERSION, finnhub.series, runId);
    await ensureLongPriceHistory(symbol);
    await dailyArchive();
  } catch (e) {
    logger.warn(`${symbol}: archive incomplete — ${(e as Error).message}`);
  }
}

/** A daily history fetched for another purpose — the valuation history, a backtest — kept as well. */
export async function savePriceHistory(ticker: string, px: PriceHistory): Promise<void> {
  await savePriceBars(ticker, px.dates.map((day, k) => ({
    day, close: px.close[k], adjClose: px.adj[k],
    open: px.open?.[k] ?? null, high: px.high?.[k] ?? null, low: px.low?.[k] ?? null, volume: px.volume?.[k] ?? null,
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
 * The market's own series, once a day per process: a refresh touches a hundred
 * stocks a night and every one of them is measured against the same ones.
 */
let archivedDay: string | null = null;
async function dailyArchive(): Promise<void> {
  if (archivedDay === today()) return;
  archivedDay = today();
  await refreshBenchmarks();
  await syncMacroSeries();
}

/**
 * The index, VIX, the dollar, the sector ETFs — and the rate of every currency
 * a stored stock trades in, so its returns can be restated in the benchmarks'.
 */
async function refreshBenchmarks(): Promise<void> {
  const dir = join(getConfig().dataDir, 'backtest', 'prices');
  const currencies = new Set((await quoteCurrencies()).map((c) => majorCurrency(c)!));
  currencies.delete(BENCHMARK_CURRENCY);
  const fx = [...currencies].sort().map((c) => fxTicker(c, BENCHMARK_CURRENCY));
  for (const ticker of [...BENCHMARK_TICKERS, ...fx]) {
    const coverage = await priceCoverage(ticker);
    const years = coverage.days >= BACKFILLED_DAYS ? 1 : BACKFILL_YEARS;
    const from = `${Number(today().slice(0, 4)) - years}${today().slice(4)}`;
    const px = await priceHistory(ticker, from, dir, 1);
    if (px) await savePriceHistory(ticker, px);
  }
}

/**
 * Series the models do not read but an evaluation will want beside the ones
 * they do: the short end of the curve, the policy rate, inflation and its
 * expectation, unemployment. Cheap to keep, impossible to reconstruct as they
 * were known on a day once revised.
 */
const CONTEXT_FRED_SERIES = ['DGS2', 'DGS3MO', 'DFF', 'T10YIE', 'CPIAUCSL', 'UNRATE'];
/** How far back a series reaches the first time it is fetched. */
const MACRO_SINCE = '1990-01-01';
/** Re-read this much before the newest stored day, so revisions replace what they revise. */
const MACRO_REVISION_DAYS = 45;

/**
 * Every FRED series the app reads, plus a few for context, by the date each
 * value is for — the full history once, then the tail daily. And Damodaran's
 * monthly implied premium, the one market input that is not on FRED.
 */
export async function syncMacroSeries(): Promise<void> {
  const apiKey = getConfig().fredApiKey;
  if (apiKey) {
    for (const series of [...new Set([...READ_FRED_SERIES, ...CONTEXT_FRED_SERIES])]) {
      try {
        const last = await lastMacroDay(series);
        const since = last
          ? new Date(Date.parse(last) - MACRO_REVISION_DAYS * 86_400_000).toISOString().slice(0, 10)
          : MACRO_SINCE;
        await saveMacroSeries(series, await fetchSeriesSince(series, apiKey, since));
      } catch (e) {
        logger.warn(`Macro archive ${series}: ${(e as Error).message}`);
      }
    }
  }
  try {
    const erp = await getImpliedERPSeries();
    // Monthly, labelled "YYYY-MM": stored on the first of its month.
    await saveMacroSeries('DAMODARAN_IMPLIED_ERP', erp.flatMap((x) => (x.asOf ? [{ day: `${x.asOf.slice(0, 7)}-01`, value: x.premium }] : [])));
  } catch (e) {
    logger.warn(`Macro archive implied ERP: ${(e as Error).message}`);
  }
}
