/* eslint-disable @typescript-eslint/no-explicit-any */
import YahooFinance from 'yahoo-finance2';
import { MacroContext } from '../types.js';
import { DailyBar } from '../analysis/technical.js';
import { getMacroSpreads } from './fred.js';
import { logger } from '../utils/logger.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false, logOptionsErrors: false } } as any);

const VIX_SYMBOL = '^VIX';
export const SPY_SYMBOL = '^GSPC';
const DXY_SYMBOL = 'DX-Y.NYB';

// Yahoo `assetProfile.sector` → SPDR sector ETF
const SECTOR_ETF_MAP: Record<string, string> = {
  'Technology':              'XLK',
  'Information Technology':  'XLK',
  'Energy':                  'XLE',
  'Financial Services':      'XLF',
  'Financials':              'XLF',
  'Industrials':             'XLI',
  'Healthcare':              'XLV',
  'Health Care':             'XLV',
  'Consumer Cyclical':       'XLY',
  'Consumer Discretionary':  'XLY',
  'Consumer Defensive':      'XLP',
  'Consumer Staples':        'XLP',
  'Utilities':               'XLU',
  'Basic Materials':         'XLB',
  'Materials':               'XLB',
  'Real Estate':             'XLRE',
  'Communication Services':  'XLC',
};

/**
 * The market's own series — the index, the dollar and every sector ETF — that
 * the price archive keeps beside the stocks: returns are measured against
 * them, so an evaluation without them has nothing to measure against.
 */
/** The benchmarks' currency: a listing in any other is restated in it before it is compared. */
export const BENCHMARK_CURRENCY = 'USD';

export const BENCHMARK_TICKERS: readonly string[] = [...new Set([
  // The index the macro block reads, and the fund that also pays its dividends.
  SPY_SYMBOL, 'SPY', VIX_SYMBOL, DXY_SYMBOL, ...Object.values(SECTOR_ETF_MAP),
])];

export function sectorToEtf(sector: string | null): string | null {
  if (!sector) return null;
  return SECTOR_ETF_MAP[sector] ?? null;
}

export async function fetchDailyBars(symbol: string, daysBack = 200): Promise<DailyBar[]> {
  try {
    const from = new Date();
    from.setDate(from.getDate() - daysBack);
    const data = await (yf as any).chart(symbol, {
      period1: from.toISOString().slice(0, 10),
      period2: new Date().toISOString().slice(0, 10),
      interval: '1d',
    });
    const quotes: any[] = data?.quotes ?? [];
    const bars: DailyBar[] = [];
    for (const q of quotes) {
      const close = q.adjclose ?? q.close;
      if (typeof close !== 'number' || !isFinite(close)) continue;
      const d: Date = q.date instanceof Date ? q.date : new Date(typeof q.date === 'number' ? q.date * 1000 : q.date);
      bars.push({
        date:   d,
        open:   typeof q.open   === 'number' ? q.open   : close,
        high:   typeof q.high   === 'number' ? q.high   : close,
        low:    typeof q.low    === 'number' ? q.low    : close,
        close,
        volume: typeof q.volume === 'number' ? q.volume : 0,
      });
    }
    return bars;
  } catch (e) {
    logger.warn(`Daily bars[${symbol}]: ${(e as Error).message}`);
    return [];
  }
}

async function fetchLatestQuote(symbol: string): Promise<number | null> {
  try {
    const q = await yf.quote(symbol);
    const v = (q as any)?.regularMarketPrice;
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch (e) {
    logger.warn(`Quote[${symbol}]: ${(e as Error).message}`);
    return null;
  }
}

function vixRegime(vix: number | null): MacroContext['vixRegime'] {
  if (vix === null) return 'unknown';
  if (vix < 15)     return 'low';
  if (vix < 20)     return 'normal';
  if (vix < 30)     return 'elevated';
  return 'high';
}

function returnOver(bars: DailyBar[], days: number): number | null {
  if (bars.length <= days) return null;
  const past = bars[bars.length - 1 - days].close;
  const last = bars[bars.length - 1].close;
  if (past === 0) return null;
  return (last - past) / past;
}

export interface MacroBundle {
  context:    MacroContext;
  spyBars:    DailyBar[];
  sectorBars: DailyBar[] | null;
}

/**
 * How long one market reading is shared. VIX, the index, the dollar and a
 * sector ETF are the same for every stock refreshed in the same half hour, and
 * a night that refreshes a hundred reference stocks used to fetch them a
 * hundred times.
 */
const MACRO_TTL_MS = 30 * 60_000;
const macroMemo = new Map<string, { at: number; value: Promise<MacroBundle> }>();

export function getMacroBundle(
  sector: string | null,
  fredApiKey: string | null,
): Promise<MacroBundle> {
  const key = `${sectorToEtf(sector) ?? '-'}|${fredApiKey ? 'fred' : '-'}`;
  const hit = macroMemo.get(key);
  if (hit && Date.now() - hit.at < MACRO_TTL_MS) return hit.value;
  const entry = { at: Date.now(), value: fetchMacroBundle(sector, fredApiKey) };
  // The fetches report failure as an empty series; an index that did not load
  // is not a reading to share for half an hour.
  const forget = () => { if (macroMemo.get(key) === entry) macroMemo.delete(key); };
  entry.value.then((b) => { if (b.spyBars.length === 0) forget(); }, forget);
  macroMemo.set(key, entry);
  return entry.value;
}

async function fetchMacroBundle(
  sector: string | null,
  fredApiKey: string | null,
): Promise<MacroBundle> {
  const etf = sectorToEtf(sector);

  const [vix, spyBars, dxyBars, sectorBars, spreads] = await Promise.all([
    fetchLatestQuote(VIX_SYMBOL),
    fetchDailyBars(SPY_SYMBOL, 200),
    fetchDailyBars(DXY_SYMBOL, 200),
    etf ? fetchDailyBars(etf, 200) : Promise.resolve([]),
    fredApiKey ? getMacroSpreads(fredApiKey) : Promise.resolve({ yieldCurve2Y10YBps: null, hySpreadBps: null }),
  ]);

  const dxyLevel = dxyBars.length > 0 ? dxyBars[dxyBars.length - 1].close : null;

  const context: MacroContext = {
    vix,
    vixRegime:         vixRegime(vix),
    spy3MReturn:       returnOver(spyBars, 63),
    yieldCurve2Y10Y:   spreads.yieldCurve2Y10YBps,
    hySpreadBps:       spreads.hySpreadBps,
    dxyLevel,
    dxyChange3MPct:    returnOver(dxyBars, 63),
    sectorEtfSymbol:   etf,
    sectorEtfReturn3M: sectorBars.length > 0 ? returnOver(sectorBars, 63) : null,
    fetchedAt:         new Date().toISOString(),
  };

  logger.debug(`Macro: VIX=${vix?.toFixed(1) ?? 'N/A'} (${context.vixRegime})  SPY3M=${(context.spy3MReturn !== null ? (context.spy3MReturn * 100).toFixed(1) + '%' : 'N/A')}  Sector=${etf ?? 'none'}`);

  return {
    context,
    spyBars,
    sectorBars: sectorBars.length > 0 ? sectorBars : null,
  };
}
