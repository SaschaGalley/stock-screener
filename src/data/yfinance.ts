/* eslint-disable @typescript-eslint/no-explicit-any */
import YahooFinance from 'yahoo-finance2';
import {
  AnalystRatingDelta,
  EarningsRevisions,
  ImpliedMove,
  OptionsSignals,
  PrevYearSnapshot,
  RevisionPeriod,
  StockFinancials,
} from '../types.js';
import { DailyBar } from '../analysis/technical.js';
import { logger } from '../utils/logger.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false, logOptionsErrors: false } } as any);

function num(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  return null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function toDateStr(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 0) return new Date(v * 1000).toISOString().slice(0, 10);
  if (typeof v === 'object' && v !== null && 'raw' in (v as any)) return toDateStr((v as any).raw);
  return null;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function safeQuote(symbol: string): Promise<any> {
  try { return await yf.quote(symbol); }
  catch (e) { logger.warn(`Quote: ${(e as Error).message}`); return null; }
}

/**
 * FX spot rate `from → to` via Yahoo's currency pseudo-ticker (e.g. "CNYUSD=X").
 * Returns 1 when the currencies match, null on any failure (caller falls back
 * to no conversion). Used to reconcile ADRs/foreign listings where Yahoo
 * reports market data (price, marketCap, targets) in the trading currency but
 * the financial statements in the reporting currency — mixing the two silently
 * corrupts every per-share valuation model.
 */
async function fetchFxRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  try {
    const q = await yf.quote(`${from}${to}=X`);
    const r = num((q as any)?.regularMarketPrice);
    return r !== null && r > 0 ? r : null;
  } catch (e) {
    logger.warn(`FX ${from}${to}=X: ${(e as Error).message}`);
    return null;
  }
}

async function safeSummary(symbol: string): Promise<any> {
  try {
    return await yf.quoteSummary(symbol, {
      modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail', 'assetProfile', 'price', 'recommendationTrend', 'earningsHistory', 'earningsTrend', 'insiderTransactions', 'calendarEvents', 'majorHoldersBreakdown'],
    } as any);
  } catch (e) { logger.warn(`Summary: ${(e as Error).message}`); return null; }
}

interface HistoricalData {
  monthlyReturns: number[];
  monthlyPrices: Record<string, number>;  // "YYYY-MM" → price
  dailyBars: DailyBar[];
}

async function safeHistoricalData(symbol: string): Promise<HistoricalData> {
  try {
    const fromMonthly = new Date();
    fromMonthly.setFullYear(fromMonthly.getFullYear() - 5);
    const fromDaily = new Date();
    fromDaily.setDate(fromDaily.getDate() - 380);  // ~1Y of daily bars + buffer for SMA200 + 3M lookback

    const [monthly, daily] = await Promise.all([
      (yf as any).chart(symbol, {
        period1: fromMonthly.toISOString().slice(0, 10),
        period2: new Date().toISOString().slice(0, 10),
        interval: '1mo',
      }),
      (yf as any).chart(symbol, {
        period1: fromDaily.toISOString().slice(0, 10),
        period2: new Date().toISOString().slice(0, 10),
        interval: '1d',
      }),
    ]);

    // Monthly: build returns + price-by-yearmonth
    const monthlyQuotes: any[] = monthly?.quotes ?? [];
    const priceList: Array<{ ym: string; price: number }> = [];
    for (const q of monthlyQuotes) {
      const price = q.adjclose ?? q.close;
      if (typeof price !== 'number' || !isFinite(price)) continue;
      const d: Date = q.date instanceof Date ? q.date : new Date(typeof q.date === 'number' ? q.date * 1000 : q.date);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      priceList.push({ ym, price });
    }

    const recent = priceList.slice(-13);
    const monthlyReturns: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1].price;
      if (!(prev > 0)) continue;   // skip zero/negative base → avoid Infinity/NaN returns
      monthlyReturns.push((recent[i].price - prev) / prev);
    }

    const monthlyPrices: Record<string, number> = {};
    for (const { ym, price } of priceList) {
      monthlyPrices[ym] = price;
    }

    // Daily: build bars
    const dailyQuotes: any[] = daily?.quotes ?? [];
    const dailyBars: DailyBar[] = [];
    for (const q of dailyQuotes) {
      const close = q.adjclose ?? q.close;
      if (typeof close !== 'number' || !isFinite(close)) continue;
      const d: Date = q.date instanceof Date ? q.date : new Date(typeof q.date === 'number' ? q.date * 1000 : q.date);
      dailyBars.push({
        date:   d,
        open:   typeof q.open   === 'number' ? q.open   : close,
        high:   typeof q.high   === 'number' ? q.high   : close,
        low:    typeof q.low    === 'number' ? q.low    : close,
        close,
        volume: typeof q.volume === 'number' ? q.volume : 0,
      });
    }

    return { monthlyReturns, monthlyPrices, dailyBars };
  } catch (e) {
    logger.warn(`Historical: ${(e as Error).message}`);
    return { monthlyReturns: [], monthlyPrices: {}, dailyBars: [] };
  }
}

function ymShift(ym: string, delta: number): string {
  const year = parseInt(ym.slice(0, 4));
  const month = parseInt(ym.slice(5, 7)) - 1;
  const d = new Date(year, month + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function safeTimeSeries(symbol: string, module: 'balance-sheet' | 'financials' | 'cash-flow'): Promise<any[]> {
  try {
    const from = new Date();
    from.setFullYear(from.getFullYear() - 5);
    const data = await yf.fundamentalsTimeSeries(symbol, {
      period1: from.toISOString().slice(0, 10),
      type: 'annual',
      module,
    } as any);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    logger.warn(`TimeSeries[${module}]: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Fetch quarterly income-statement series (last ~2 years of fiscal quarters).
 * Used for the Simple Valuation Ratio = Market Cap / (latest quarter revenue × 4),
 * which is more responsive to growth/decline inflections than the TTM-based
 * priceToSales because it drops the older 3 quarters from the denominator.
 */
async function safeQuarterlyFinancials(symbol: string): Promise<any[]> {
  try {
    const from = new Date();
    from.setFullYear(from.getFullYear() - 2);
    const data = await yf.fundamentalsTimeSeries(symbol, {
      period1: from.toISOString().slice(0, 10),
      type: 'quarterly',
      module: 'financials',
    } as any);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    logger.warn(`TimeSeries[financials,quarterly]: ${(e as Error).message}`);
    return [];
  }
}

// ─── Symbol resolution ────────────────────────────────────────────────────────

type YFSearchQuote = {
  symbol?: string; shortname?: string; longname?: string;
  quoteType?: string; sector?: string; isin?: string;
};

async function yahooSearch(query: string, count = 8): Promise<YFSearchQuote[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${count}&newsCount=0&enableFuzzyQuery=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return [];
  const data = await res.json() as { quotes?: YFSearchQuote[] };
  return data.quotes ?? [];
}

function pickBestEquity(quotes: YFSearchQuote[]): YFSearchQuote | undefined {
  const equities = quotes.filter((q) => q.quoteType === 'EQUITY' && q.symbol);
  return equities.find((q) => q.sector) ?? equities[0];
}

export async function resolveSymbol(input: string): Promise<string> {
  try {
    const q = await yf.quote(input);
    if ((q as any)?.regularMarketPrice) return input;
  } catch { /* fall through to search */ }

  try {
    const quotes = await yahooSearch(input);
    const match = pickBestEquity(quotes);
    if (match?.symbol && match.symbol !== input) {
      logger.info(`Resolved "${input}" → "${match.symbol}" (${match.longname ?? match.shortname ?? ''})`);
      return match.symbol;
    }
  } catch (e) {
    logger.warn(`Symbol lookup failed: ${(e as Error).message}`);
  }

  return input;
}

export async function searchByQuery(query: string): Promise<string> {
  try {
    const quotes = await yahooSearch(query, 10);
    const match = pickBestEquity(quotes);
    if (match?.symbol) {
      logger.info(`"${query}" → ${match.symbol} (${match.longname ?? match.shortname ?? ''})`);
      return match.symbol;
    }
  } catch (e) {
    logger.warn(`Query search failed: ${(e as Error).message}`);
  }
  throw new Error(`No equity found for query "${query}" — try a more specific name or use the ticker directly`);
}

/**
 * Fetch the ISIN from Wikidata.
 *
 * Background: Yahoo Finance silently dropped the `isin` field from
 * /v1/finance/search at some point — empirically empty for US, FR, and DE
 * tickers. Google Finance only embeds ISINs as part of news-article URLs in
 * its rendered HTML, which makes scraping prone to picking up *unrelated*
 * companies' ISINs (verified e.g. for JPM where Commerzbank news links yielded
 * DE000CBK1001). Wikidata, on the other hand, has a curated `P946` claim
 * (ISIN) on every major listed company — globally, multilingual, free, and
 * available as a structured JSON API.
 *
 * Lookup flow:
 *   1) wbsearchentities by company longName → up to 5 candidate Q-ids.
 *   2) For each candidate, fetch the entity JSON and read claims.P946.
 *   3) Return the first ISIN that matches the canonical 12-char shape.
 *
 * Edge cases:
 * - The longName from Yahoo (`pr.longName`) is what we feed in. If only the
 *   ticker is available, search falls back to that — works for some symbols
 *   but is less reliable.
 * - Tested across AAPL, MSFT, NVDA, JPM, BAC, BRK-B, AIR.PA (NL parent),
 *   BMW.DE, ENR.DE, NESN.SW, ASML.AS, SAP.DE, TM, TSM — all resolved when
 *   given the proper company name.
 */
async function fetchIsin(symbol: string, longName: string | null): Promise<string | null> {
  const queryName = longName ?? symbol;
  const ua = 'stock-cli/0.1 (research-tool; xashmedia@gmail.com)';
  try {
    const searchUrl =
      `https://www.wikidata.org/w/api.php?action=wbsearchentities` +
      `&search=${encodeURIComponent(queryName)}` +
      `&language=en&format=json&limit=5&type=item`;
    const sr = await fetch(searchUrl, {
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(5_000),
    });
    if (!sr.ok) return null;
    const sd = await sr.json() as { search?: Array<{ id: string }> };
    const candidates = (sd.search ?? []).slice(0, 5).map((s) => s.id);

    for (const qid of candidates) {
      const er = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, {
        headers: { 'User-Agent': ua },
        signal: AbortSignal.timeout(5_000),
      });
      if (!er.ok) continue;
      const ed = await er.json() as { entities?: Record<string, { claims?: Record<string, any[]> }> };
      const isinClaims = ed.entities?.[qid]?.claims?.P946 ?? [];
      for (const c of isinClaims) {
        const v = c?.mainsnak?.datavalue?.value;
        if (typeof v === 'string' && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(v)) {
          return v;
        }
      }
    }
  } catch (e) {
    logger.warn(`Wikidata ISIN lookup failed for ${symbol}: ${(e as Error).message}`);
  }
  return null;
}

// ─── Earnings revisions / analyst MoM extraction ──────────────────────────────

function extractRevisions(earningsTrend: any[]): RevisionPeriod[] {
  const out: RevisionPeriod[] = [];
  for (const t of earningsTrend.slice(0, 4)) {
    const period = str(t?.period) ?? 'Unknown';
    const epsTrend = t?.epsTrend ?? {};
    const revisions = t?.epsRevisions ?? {};
    const current  = num(epsTrend?.current);
    const ago30d   = num(epsTrend?.['30daysAgo']);
    const up30d    = num(revisions?.upLast30days);
    const down30d  = num(revisions?.downLast30days);

    out.push({
      period,
      epsTrend: {
        current,
        ago7d:  num(epsTrend?.['7daysAgo']),
        ago30d,
        ago60d: num(epsTrend?.['60daysAgo']),
        ago90d: num(epsTrend?.['90daysAgo']),
      },
      revisions: {
        up7d:    num(revisions?.upLast7days),
        up30d,
        up90d:   num(revisions?.upLast90days),
        down7d:  num(revisions?.downLast7Days),
        down30d,
        down90d: num(revisions?.downLast90days),
      },
      netRevision30d: up30d !== null && down30d !== null ? up30d - down30d : null,
      epsChange30dPct: current !== null && ago30d !== null && ago30d !== 0
        ? (current - ago30d) / Math.abs(ago30d)
        : null,
    });
  }
  return out;
}

function extractAnalystRatingMoMDelta(recommendationTrend: any[]): AnalystRatingDelta | null {
  const cur = recommendationTrend?.[0];
  const prev = recommendationTrend?.[1];
  if (!cur || !prev) return null;
  return {
    strongBuy:  (num(cur.strongBuy)  ?? 0) - (num(prev.strongBuy)  ?? 0),
    buy:        (num(cur.buy)        ?? 0) - (num(prev.buy)        ?? 0),
    hold:       (num(cur.hold)       ?? 0) - (num(prev.hold)       ?? 0),
    sell:       (num(cur.sell)       ?? 0) - (num(prev.sell)       ?? 0),
    strongSell: (num(cur.strongSell) ?? 0) - (num(prev.strongSell) ?? 0),
  };
}

// ─── Options chain ────────────────────────────────────────────────────────────

interface OptionsInputs {
  symbol: string;
  spot: number;
  nextEarningsDate: string | null;
  hv90: number | null;
}

export async function getOptionsSignals(input: OptionsInputs): Promise<OptionsSignals | null> {
  const { symbol, spot, nextEarningsDate, hv90 } = input;
  if (!spot || spot <= 0) return null;

  try {
    // 1. First call: get the full list of expiration dates (yf.options returns only one chain by default).
    const initial = await (yf as any).options(symbol);
    const allExpDates: Date[] = (initial?.expirationDates ?? []).filter((d: any) => d instanceof Date);
    if (allExpDates.length === 0) return null;

    const now = Date.now();
    const daysTo = (d: Date) => Math.round((d.getTime() - now) / (24 * 60 * 60 * 1000));

    // 2. Pick an expiry close to 30d (skip 0DTE — IV is meaningless there).
    const ivExpDate = pickClosestExpiry(allExpDates, 30, 14);

    // 3. Find the first expiry strictly after the next earnings date (for implied move).
    const earningsTime = nextEarningsDate ? new Date(nextEarningsDate).getTime() : null;
    const postEarningsExpDate = earningsTime !== null
      ? allExpDates.find((d) => d.getTime() > earningsTime) ?? null
      : null;

    // 4. Fetch the chain(s) we need. Reuse `initial` if it happens to match.
    const initialDate: Date | null = initial?.options?.[0]?.expirationDate ?? null;
    const same = (a: Date | null, b: Date | null) => a !== null && b !== null && a.getTime() === b.getTime();

    const dateChainPromises: Array<Promise<{ date: Date; chain: any } | null>> = [];
    const seen = new Set<number>();

    const addFetch = (d: Date | null) => {
      if (!d || seen.has(d.getTime())) return;
      seen.add(d.getTime());
      if (same(d, initialDate)) {
        dateChainPromises.push(Promise.resolve({ date: d, chain: initial.options[0] }));
      } else {
        dateChainPromises.push(
          (yf as any).options(symbol, { date: d })
            .then((res: any) => res?.options?.[0] ? { date: d, chain: res.options[0] } : null)
            .catch(() => null),
        );
      }
    };

    addFetch(ivExpDate);
    addFetch(postEarningsExpDate);

    const chains = (await Promise.all(dateChainPromises)).filter((x): x is { date: Date; chain: any } => x !== null);
    const ivChainEntry      = chains.find((c) => same(c.date, ivExpDate));
    const postEarningsEntry = chains.find((c) => same(c.date, postEarningsExpDate));

    const ivAtm30d = ivChainEntry ? computeAtmIv(ivChainEntry.chain, spot) : null;
    const pc       = ivChainEntry ? computePutCallRatios(ivChainEntry.chain, spot) : { volRatio: null, oiRatio: null };

    let impliedMove: ImpliedMove | null = null;
    if (postEarningsEntry) {
      const movePct = computeImpliedMove(postEarningsEntry.chain, spot);
      if (movePct !== null) {
        impliedMove = {
          pct: movePct,
          expirationDate: postEarningsEntry.date.toISOString().slice(0, 10),
        };
      }
    }

    logger.debug(`Options[${symbol}]: IV-expiry=${ivExpDate ? ivExpDate.toISOString().slice(0,10) : 'N/A'} (${ivExpDate ? daysTo(ivExpDate) : 'N/A'}d), post-earnings=${postEarningsExpDate ? postEarningsExpDate.toISOString().slice(0,10) : 'N/A'}`);

    return {
      ivAtm30d,
      putCallVolumeRatio: pc.volRatio,
      putCallOIRatio:     pc.oiRatio,
      nextEarningsImpliedMove: impliedMove,
      ivVsHv90Ratio: ivAtm30d !== null && hv90 !== null && hv90 > 0 ? ivAtm30d / hv90 : null,
    };
  } catch (e) {
    logger.warn(`Options[${symbol}]: ${(e as Error).message}`);
    return null;
  }
}

function pickClosestExpiry(dates: Date[], targetDays: number, minDays: number): Date | null {
  const now = Date.now();
  const eligible = dates.filter((d) => Math.round((d.getTime() - now) / (24 * 60 * 60 * 1000)) >= minDays);
  if (eligible.length === 0) return null;
  return eligible.reduce<{ d: Date; diff: number } | null>((best, d) => {
    const days = Math.round((d.getTime() - now) / (24 * 60 * 60 * 1000));
    const diff = Math.abs(days - targetDays);
    return best === null || diff < best.diff ? { d, diff } : best;
  }, null)!.d;
}

/**
 * Estimate ATM implied volatility from the option chain.
 *
 * Yahoo's `impliedVolatility` field is frequently stale or garbage (zeros, near-zeros,
 * inconsistent across nearby strikes). We derive IV from the ATM straddle mid-price using
 * the Brenner–Subrahmanyam approximation:
 *
 *   straddle / spot ≈ 0.8 × σ × √T   →   σ ≈ straddle / spot / (0.8 × √T)
 *
 * Fall back to Yahoo's reported IV (averaged across ATM call+put) only when straddle pricing
 * is missing.
 */
function computeAtmIv(expiration: any, spot: number): number | null {
  const calls: any[] = expiration?.calls ?? [];
  const puts:  any[] = expiration?.puts  ?? [];
  if (calls.length === 0 && puts.length === 0) return null;

  const nearest = (arr: any[]) => arr.reduce<{ s: any; d: number } | null>((best, c) => {
    const strike = num(c.strike);
    if (strike === null) return best;
    const d = Math.abs(strike - spot);
    if (best === null || d < best.d) return { s: c, d };
    return best;
  }, null);

  const cAtm = nearest(calls);
  const pAtm = nearest(puts);

  // Time to expiry in years
  const expDate: Date | undefined = expiration?.expirationDate;
  const tYears = expDate ? Math.max(1, (expDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) / 365 : null;

  // Preferred path: derive IV from ATM straddle mid-price.
  if (cAtm && pAtm && tYears !== null && tYears > 0) {
    const cMid = midPrice(cAtm.s);
    const pMid = midPrice(pAtm.s);
    if (cMid !== null && pMid !== null && cMid > 0 && pMid > 0) {
      const straddle = cMid + pMid;
      const sigma = (straddle / spot) / (0.8 * Math.sqrt(tYears));
      if (isFinite(sigma) && sigma > 0.02 && sigma < 5) return sigma;  // sane range: 2% – 500%
    }
  }

  // Fallback: average Yahoo's reported IV from the ATM call+put, if it looks plausible.
  const ivs: number[] = [];
  const cIv = cAtm ? num(cAtm.s.impliedVolatility) : null;
  const pIv = pAtm ? num(pAtm.s.impliedVolatility) : null;
  if (cIv !== null && cIv > 0.02 && cIv < 5) ivs.push(cIv);
  if (pIv !== null && pIv > 0.02 && pIv < 5) ivs.push(pIv);
  if (ivs.length === 0) return null;
  return ivs.reduce((a, b) => a + b, 0) / ivs.length;
}

function computePutCallRatios(expiration: any, spot: number): { volRatio: number | null; oiRatio: number | null } {
  const within = (s: number) => Math.abs(s - spot) / spot <= 0.15;
  const calls: any[] = (expiration?.calls ?? []).filter((c: any) => num(c.strike) !== null && within(c.strike));
  const puts:  any[] = (expiration?.puts  ?? []).filter((p: any) => num(p.strike) !== null && within(p.strike));
  const sumCallVol = calls.reduce((a, c) => a + (num(c.volume)       ?? 0), 0);
  const sumPutVol  = puts.reduce ((a, p) => a + (num(p.volume)       ?? 0), 0);
  const sumCallOI  = calls.reduce((a, c) => a + (num(c.openInterest) ?? 0), 0);
  const sumPutOI   = puts.reduce ((a, p) => a + (num(p.openInterest) ?? 0), 0);
  return {
    volRatio: sumCallVol > 0 ? sumPutVol / sumCallVol : null,
    oiRatio:  sumCallOI  > 0 ? sumPutOI  / sumCallOI  : null,
  };
}

function computeImpliedMove(expiration: any, spot: number): number | null {
  const calls: any[] = expiration?.calls ?? [];
  const puts:  any[] = expiration?.puts  ?? [];
  const nearest = (arr: any[]) => arr.reduce<{ o: any; d: number } | null>((best, c) => {
    const strike = num(c.strike);
    if (strike === null) return best;
    const d = Math.abs(strike - spot);
    if (best === null || d < best.d) return { o: c, d };
    return best;
  }, null);
  const c = nearest(calls);
  const p = nearest(puts);
  if (!c || !p) return null;
  const cMid = midPrice(c.o);
  const pMid = midPrice(p.o);
  if (cMid === null || pMid === null) return null;
  return (cMid + pMid) / spot;
}

function midPrice(opt: any): number | null {
  const bid = num(opt?.bid);
  const ask = num(opt?.ask);
  if (bid !== null && ask !== null && bid > 0 && ask > 0) return (bid + ask) / 2;
  return num(opt?.lastPrice);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface FinancialsBundle {
  financials: StockFinancials;
  dailyBars:  DailyBar[];
  revisions:  EarningsRevisions;
}

export async function getFinancials(symbol: string): Promise<FinancialsBundle> {
  logger.step(`Fetching financials for ${symbol}...`);

  const [quote, summary, bsData, finData, cfData, finQData, historicalData] = await Promise.all([
    safeQuote(symbol),
    safeSummary(symbol),
    safeTimeSeries(symbol, 'balance-sheet'),
    safeTimeSeries(symbol, 'financials'),
    safeTimeSeries(symbol, 'cash-flow'),
    safeQuarterlyFinancials(symbol),
    safeHistoricalData(symbol),
  ]);

  const { monthlyReturns, monthlyPrices, dailyBars } = historicalData;

  if (!quote && !summary) throw new Error(`No data found for: ${symbol}`);

  const fd = summary?.financialData        ?? {};
  const ks = summary?.defaultKeyStatistics ?? {};
  const sd = summary?.summaryDetail        ?? {};
  const ap = summary?.assetProfile         ?? {};
  const pr = summary?.price                ?? {};

  // ── Currency reconciliation ───────────────────────────────────────────────
  // Yahoo reports market data (price, marketCap, analyst targets, the quote's
  // trailing EPS) in the TRADING currency, but the financial statements
  // (revenue, net income, FCF, debt, book value, the EPS/FCF history) in the
  // REPORTING currency. For ADRs and foreign listings these differ (e.g. BABA:
  // price USD, statements CNY), and mixing them turns every per-share model
  // into garbage — a P/B of price$ / bookValue¥, a DCF of ¥-FCF bridged to a
  // $-price. We fetch the spot FX rate once and convert all statement-sourced
  // figures into the trading currency so the whole pipeline downstream can stay
  // currency-agnostic. Verified against the identity
  // netIncome¥ / sharesADS × FX ≈ trailing EPS$ (Yahoo's own quote figure).
  const tradingCurrency   = str(pr.currency) ?? str((quote as any)?.currency) ?? str(sd.currency) ?? null;
  const financialCurrency = str(fd.financialCurrency) ?? null;
  const fxRate = (tradingCurrency && financialCurrency && tradingCurrency !== financialCurrency)
    ? (await fetchFxRate(financialCurrency, tradingCurrency)) ?? 1
    : 1;
  if (fxRate !== 1) {
    logger.info(`Currency: ${financialCurrency}→${tradingCurrency} statements ×${fxRate.toFixed(4)} for ${symbol}`);
  }
  /** Convert a statement-currency (reporting) amount into the trading currency. */
  const fxc = (n: number | null): number | null => (n === null ? null : n * fxRate);
  /** Convert a {year,value} history series of statement-currency values. */
  const fxcSeries = (s: { year: number; value: number }[]) =>
    fxRate === 1 ? s : s.map((p) => ({ year: p.year, value: p.value * fxRate }));

  // ISIN: kicked off as soon as we have the company longName from Yahoo's
  // price module. Wikidata's wbsearchentities works best with the canonical
  // company name (not the ticker), e.g. "ASML Holding" rather than "ASML.AS".
  // Run in parallel with the rest of the parsing below — usually finishes
  // before the function returns.
  const longNameForIsin = str(pr.longName) ?? str(pr.shortName) ?? null;
  const isinPromise = fetchIsin(symbol, longNameForIsin);
  const rtTrend: any[] = (summary as any)?.recommendationTrend?.trend ?? [];
  const rt  = rtTrend?.[0] ?? {};
  const cal = (summary as any)?.calendarEvents ?? {};
  const mhb = (summary as any)?.majorHoldersBreakdown ?? {};
  const eh  = (summary as any)?.earningsHistory?.history ?? [];
  const et  = (summary as any)?.earningsTrend?.trend ?? [];
  const itx: any[] = (summary as any)?.insiderTransactions?.transactions ?? [];

  // Most recent annual period (last element = most recent)
  const bs  = bsData[bsData.length - 1]   ?? {};
  const inc = finData[finData.length - 1]  ?? {};
  const cf  = cfData[cfData.length - 1]    ?? {};

  // Prior year (second-to-last)
  const bs1  = bsData[bsData.length - 2]  ?? null;
  const inc1 = finData[finData.length - 2] ?? null;
  const cf1  = cfData[cfData.length - 2]   ?? null;

  // ── Balance sheet ─────────────────────────────────────────────────────────
  const totalAssets             = num(bs.totalAssets);
  const totalCurrentAssets      = num(bs.currentAssets);
  const totalCurrentLiabilities = num(bs.currentLiabilities);
  const totalLiabilities        = num(bs.totalLiabilitiesNetMinorityInterest);
  const retainedEarnings        = num(bs.retainedEarnings);
  const longTermDebt            = num(bs.longTermDebt);
  const workingCapital          = num(bs.workingCapital)
    ?? (totalCurrentAssets !== null && totalCurrentLiabilities !== null
        ? totalCurrentAssets - totalCurrentLiabilities : null);

  // ── Income statement ──────────────────────────────────────────────────────
  const ebit             = num((inc as any).EBIT) ?? num(inc.operatingIncome);
  const grossProfit      = num(inc.grossProfit);
  const interestExpense  = num(inc.interestExpense)
    ?? num((inc as any).interestExpenseNonOperating);
  const incomeTaxExpense = num(inc.taxProvision);
  const incomeBeforeTax  = num(inc.pretaxIncome);
  // Effective tax rate, clamped to a sane band: a genuine 0% rate is kept
  // (=== 0, not treated as missing), a tax *benefit* (negative provision) maps
  // to 0, and one-off rates above the statutory ceiling are capped at 35% so
  // NOPAT-based models (EPV) aren't distorted by a single distorted year.
  const rawTaxRate = incomeTaxExpense !== null && incomeBeforeTax !== null && incomeBeforeTax > 0
    ? incomeTaxExpense / incomeBeforeTax : null;
  const taxRate = rawTaxRate !== null ? Math.max(0, Math.min(rawTaxRate, 0.35)) : null;

  // ── Cash flow ─────────────────────────────────────────────────────────────
  const operatingCashFlowAnnual = num(cf.operatingCashFlow);
  const capexRaw = num(cf.capitalExpenditure);
  const capex = capexRaw !== null ? Math.abs(capexRaw) : null;
  const depreciation = num((cf as any).depreciationAndAmortization)
    ?? num((cf as any).depreciation);

  // ── Earnings surprises ────────────────────────────────────────────────────
  const earningsSurprises = (eh as any[]).slice(0, 4).map((q: any) => ({
    quarter:     str(q.period) ?? str(q.quarter?.fmt) ?? 'Unknown',
    epsEstimate: num(q.epsEstimate?.raw ?? q.epsEstimate),
    epsActual:   num(q.epsActual?.raw   ?? q.epsActual),
    surprisePct: num(q.surprisePercent?.raw ?? q.surprisePercent),
  }));

  // ── Forward earnings estimates ────────────────────────────────────────────
  const earningsEstimates = (et as any[]).slice(0, 4).map((t: any) => ({
    period:           str(t.period) ?? 'Unknown',
    endDate:          t.endDate instanceof Date
                        ? t.endDate.toISOString().slice(0, 10)
                        : str(t.endDate) ?? null,
    epsEstimate:      num(t.earningsEstimate?.avg?.raw ?? t.earningsEstimate?.avg),
    epsLow:           num(t.earningsEstimate?.low?.raw ?? t.earningsEstimate?.low),
    epsHigh:          num(t.earningsEstimate?.high?.raw ?? t.earningsEstimate?.high),
    epsGrowth:        num(t.earningsEstimate?.growth?.raw ?? t.earningsEstimate?.growth),
    // Consensus revenue is reported in the statement currency — convert to the
    // trading currency so forward P/S (marketCap / fwdRev) is consistent.
    revenueEstimate:  fxc(num(t.revenueEstimate?.avg?.raw ?? t.revenueEstimate?.avg)),
    revenueGrowth:    num(t.revenueEstimate?.growth?.raw ?? t.revenueEstimate?.growth),
    numberOfAnalysts: num(t.earningsEstimate?.numberOfAnalysts?.raw ?? t.earningsEstimate?.numberOfAnalysts),
  }));

  // ── Quarterly revenues (run-rate basis for SVR) ───────────────────────────
  // Yahoo's fundamentalsTimeSeries returns the period end in `date`. Sort
  // ascending and keep the last ≤8 quarters. The most recent quarter is the
  // SVR denominator: marketCap / (latestQuarterRevenue × 4).
  const quarterlyRevenues = (finQData as any[])
    .map((q: any) => {
      const rawDate: any = q.date ?? q.asOfDate ?? q.endDate;
      const d: Date | null = rawDate instanceof Date
        ? rawDate
        : typeof rawDate === 'string' ? new Date(rawDate)
        : typeof rawDate === 'number' ? new Date(rawDate * 1000)
        : null;
      // Convert to trading currency to match marketCap in the SVR (run-rate P/S).
      const rev = fxc(num(q.totalRevenue) ?? num(q.revenue));
      if (!d || isNaN(d.getTime()) || rev === null || rev <= 0) return null;
      return { endDate: d.toISOString().slice(0, 10), revenue: rev };
    })
    .filter((x): x is { endDate: string; revenue: number } => x !== null)
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
    .slice(-8);

  // ── Earnings revisions (epsTrend + epsRevisions per period) ──────────────
  const revisionPeriods = extractRevisions(et);
  const analystRatingMoMDelta = extractAnalystRatingMoMDelta(rtTrend);
  const revisions: EarningsRevisions = {
    perPeriod: revisionPeriods,
    analystRatingMoMDelta,
  };

  // ── Insider transactions (last 6 months) ─────────────────────────────────
  const sixMonthsAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;
  let insiderBuyShares = 0, insiderBuyValue = 0, insiderBuyCount = 0;
  let insiderSellShares = 0, insiderSellValue = 0, insiderSellCount = 0;
  for (const t of itx) {
    const ts = t.startDate instanceof Date ? t.startDate.getTime()
             : typeof t.startDate === 'number' ? t.startDate * 1000 : 0;
    if (ts < sixMonthsAgo) continue;
    const text = String(t.transactionText ?? '').toLowerCase();
    const shares = Math.abs(num(t.shares) ?? 0);
    const value  = Math.abs(num(t.value)  ?? 0);
    if (text.includes('sale') || text.includes('sold')) {
      insiderSellShares += shares; insiderSellValue += value; insiderSellCount++;
    } else if (text.includes('purchase') || text.includes('acquired') || text.includes('exercise')) {
      insiderBuyShares += shares; insiderBuyValue += value; insiderBuyCount++;
    }
  }

  // ── Next earnings date ────────────────────────────────────────────────────
  const earningsDates: any[] = cal.earnings?.earningsDate ?? [];
  const futureED = earningsDates.find((d: any) => {
    const dt = d instanceof Date ? d : new Date(typeof d === 'number' ? d * 1000 : d);
    return dt.getTime() > Date.now();
  });
  const nextEarningsDate = toDateStr(futureED ?? earningsDates[0]);

  // ── Prior-year snapshot for Piotroski / Beneish ──────────────────────────
  let prevYear: PrevYearSnapshot | null = null;
  if (bs1 && inc1 && cf1) {
    // Statement-currency amounts — FX-converted to match the current-year
    // figures (Piotroski/Beneish compare the two years, so both sides must be
    // in the same currency; for same-currency stocks fxRate is 1, a no-op).
    prevYear = {
      netIncome:          fxc(num(inc1.netIncome)),
      totalAssets:        fxc(num(bs1.totalAssets)),
      longTermDebt:       fxc(num(bs1.longTermDebt)),
      currentAssets:      fxc(num(bs1.currentAssets)),
      currentLiabilities: fxc(num(bs1.currentLiabilities)),
      grossProfit:        fxc(num(inc1.grossProfit)),
      revenue:            fxc(num(inc1.totalRevenue)),
      operatingCashFlow:  fxc(num(cf1.operatingCashFlow)),
      receivables:        fxc(num(bs1.accountsReceivable)),
      ppe:                fxc(num(bs1.netPPE)),
      sga:                fxc(num((inc1 as any).sellingGeneralAndAdministration)),
      depreciation:       fxc(num((cf1 as any).depreciationAndAmortization) ?? num((cf1 as any).depreciation)),
    };
  }

  // ── Multi-year fundamentals history (oldest first) ───────────────────────
  // Extracts headline metrics from the annual time-series for trend charts.
  // Yahoo's fundamentalsTimeSeries puts the period end in `date` (sometimes
  // also `asOfDate` on older shapes), so we try both.
  function asYear(entry: any): number | null {
    const raw = entry?.date ?? entry?.asOfDate;
    const d: Date | null = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
    return d && !Number.isNaN(d.getTime()) ? d.getFullYear() : null;
  }
  function series(rows: any[], pick: (row: any) => number | null): { year: number; value: number }[] {
    const out: { year: number; value: number }[] = [];
    for (const r of rows) {
      const yr = asYear(r);
      const v = pick(r);
      if (yr === null || v === null || !Number.isFinite(v)) continue;
      out.push({ year: yr, value: v });
    }
    // De-dupe by year (keep last entry — Yahoo sometimes returns TTM alongside annual)
    const byYear = new Map<number, number>();
    for (const p of out) byYear.set(p.year, p.value);
    return [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, value]) => ({ year, value }));
  }
  // All series below are statement-currency monetary values (eps is per-share
  // but still currency-denominated), so each is FX-converted into the trading
  // currency to stay consistent with the price.
  const fundamentalsHistory = {
    revenue:            fxcSeries(series(finData, (r) => num(r.totalRevenue))),
    grossProfit:        fxcSeries(series(finData, (r) => num(r.grossProfit))),
    operatingIncome:    fxcSeries(series(finData, (r) => num(r.operatingIncome) ?? num((r as any).EBIT))),
    netIncome:          fxcSeries(series(finData, (r) => num((r as any).netIncome) ?? num((r as any).netIncomeCommonStockholders))),
    eps:                fxcSeries(series(finData, (r) => num((r as any).dilutedEPS) ?? num((r as any).basicEPS))),
    freeCashFlow:       fxcSeries(series(cfData,  (r) => num((r as any).freeCashFlow))),
    operatingCashFlow:  fxcSeries(series(cfData,  (r) => num((r as any).operatingCashFlow) ?? num((r as any).cashFlowFromContinuingOperatingActivities))),
    totalAssets:        fxcSeries(series(bsData,  (r) => num(r.totalAssets))),
    stockholdersEquity: fxcSeries(series(bsData,  (r) => num((r as any).stockholdersEquity) ?? num((r as any).totalEquityGrossMinorityInterest))),
  };

  // ── 5-year average trailing P/E ──────────────────────────────────────────
  const avgPE5Y = (() => {
    const pes: number[] = [];
    for (const entry of finData) {
      const eps = num((entry as any).dilutedEPS);
      if (eps === null || eps <= 0) continue;
      // Match the canonical asYear keying: fundamentalsTimeSeries puts the
      // period end in `date` (primary); `asOfDate` only on older shapes.
      const raw = (entry as any).date ?? (entry as any).asOfDate;
      const endDate: Date | null = raw instanceof Date ? raw
        : typeof raw === 'string' ? new Date(raw) : null;
      if (!endDate || isNaN(endDate.getTime())) continue;
      const ym = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`;
      const price = monthlyPrices[ym] ?? monthlyPrices[ymShift(ym, -1)] ?? monthlyPrices[ymShift(ym, 1)];
      if (!price) continue;
      // price is in the trading currency; statement EPS is in the reporting
      // currency — convert EPS so the ratio is currency-consistent.
      const pe = price / (eps * fxRate);
      if (pe > 0 && pe < 500) pes.push(pe);
    }
    return pes.length >= 2 ? pes.reduce((a, b) => a + b, 0) / pes.length : null;
  })();

  // Resolve the parallel ISIN lookup. By the time we get here the parsing
  // above has been doing its work in parallel, so this rarely blocks.
  const isin = await isinPromise;

  const financials: StockFinancials = {
    symbol: symbol.toUpperCase(),
    companyName: str(pr.longName) ?? str(pr.shortName) ?? symbol,
    price: num(quote?.regularMarketPrice) ?? 0,
    marketCap: num(quote?.marketCap) ?? 0,

    peRatio:     (() => { const v = num(quote?.trailingPE); return v !== null && v > 0 ? v : null; })(),
    forwardPE:   (() => { const v = num(quote?.forwardPE);  return v !== null && v > 0 ? v : null; })(),
    avgPE5Y,
    pegRatio:    num(ks.pegRatio),
    eps:         num(quote?.epsTrailingTwelveMonths),
    // ks.bookValue is per-share in the reporting currency on an ambiguous basis
    // for ADRs; when currencies differ, derive BVPS from the (already FX-
    // converted) latest equity ÷ shares so it bridges cleanly to the $-price.
    bookValue:   (() => {
      if (fxRate === 1) return num(ks.bookValue);
      const eq = fundamentalsHistory.stockholdersEquity;
      const latestEq = eq.length ? eq[eq.length - 1].value : null;
      const shares = num(ks.sharesOutstanding);
      return (latestEq !== null && shares !== null && shares > 0)
        ? latestEq / shares
        : fxc(num(ks.bookValue));
    })(),

    roe:              num(fd.returnOnEquity),
    roa:              num(fd.returnOnAssets),
    operatingMargin:  num(fd.operatingMargins) ?? num(quote?.operatingMargins),
    netMargin:        num(fd.profitMargins),
    revenueGrowth:    num(fd.revenueGrowth),
    revenueGrowthYoY: num(fd.revenueGrowth),
    earningsGrowth:   num(fd.earningsGrowth),

    freeCashFlow:      fxc(num(fd.freeCashflow)),
    operatingCashFlow: fxc(num(fd.operatingCashflow)),
    totalCash:         fxc(num(fd.totalCash)),
    totalDebt:         fxc(num(fd.totalDebt) ?? num(bs.totalDebt)),
    longTermDebt:      fxc(longTermDebt),
    debtToEquity:      num(fd.debtToEquity),
    currentRatio:      num(fd.currentRatio),
    quickRatio:        num(fd.quickRatio),

    revenue:          fxc(num(fd.totalRevenue) ?? num(inc.totalRevenue)),
    grossProfit:      fxc(num(fd.grossProfits) ?? grossProfit),
    ebit:             fxc(ebit),
    netIncome:        fxc(num(fd.netIncomeToCommon) ?? num(inc.netIncome)),
    ebitda:           fxc(num(fd.ebitda)),
    interestExpense:  fxc(interestExpense),
    incomeTaxExpense: fxc(incomeTaxExpense),
    incomeBeforeTax:  fxc(incomeBeforeTax),
    taxRate,

    totalAssets:             fxc(totalAssets),
    totalCurrentAssets:      fxc(totalCurrentAssets),
    totalCurrentLiabilities: fxc(totalCurrentLiabilities),
    totalLiabilities:        fxc(totalLiabilities),
    retainedEarnings:        fxc(retainedEarnings),
    workingCapital:          fxc(workingCapital),

    operatingCashFlowAnnual: fxc(operatingCashFlowAnnual),
    capex:                   fxc(capex),
    depreciation:            fxc(depreciation),

    // EV = trading-currency market cap + converted net debt. For mismatched
    // currencies Yahoo's ks.enterpriseValue mixes a $-market-cap with ¥-debt,
    // so recompute it from the converted figures; otherwise trust Yahoo's.
    enterpriseValue:   fxRate === 1
      ? num(ks.enterpriseValue)
      : (() => {
          // Reconstruct EV from trading-currency equity + converted net debt.
          // marketCap (and price×shares) are already trading currency; never
          // FX-scale them. ks.enterpriseValue is unusable here because it mixes
          // a trading-currency market cap with reporting-currency debt, so
          // multiplying it by fxRate would double-convert the equity portion.
          const px = num(quote?.regularMarketPrice);
          const sh = num(ks.sharesOutstanding);
          const equity = num(quote?.marketCap) ?? (px !== null && sh !== null ? px * sh : null);
          if (equity === null) return null;
          const debt = fxc(num(fd.totalDebt) ?? num(bs.totalDebt)) ?? 0;
          const cash = fxc(num(fd.totalCash)) ?? 0;
          return equity + debt - cash;
        })(),
    sharesOutstanding: num(ks.sharesOutstanding),
    targetMeanPrice:   num(fd.targetMeanPrice),

    analystTargetHigh:   num(fd.targetHighPrice),
    analystTargetLow:    num(fd.targetLowPrice),
    analystTargetMedian: num(fd.targetMedianPrice),
    analystCount:        num(fd.numberOfAnalystOpinions),
    analystStrongBuy:    num(rt.strongBuy),
    analystBuy:          num(rt.buy),
    analystHold:         num(rt.hold),
    analystSell:         num(rt.sell),
    analystStrongSell:   num(rt.strongSell),

    fiftyTwoWeekHigh: num(quote?.fiftyTwoWeekHigh),
    fiftyTwoWeekLow:  num(quote?.fiftyTwoWeekLow),
    beta:             num(quote?.beta) ?? num(ks.beta),
    // yahoo-finance2 quote.dividendYield is in PERCENT (verified: AAPL 0.36,
    // KO 2.67, MO 6.13), so always /100. The old `dy > 1` heuristic left
    // sub-1% yields unscaled (AAPL 0.36 → 36%).
    dividendYield:    (() => { const dy = num(quote?.dividendYield); return dy !== null ? dy / 100 : null; })(),
    payoutRatio:      num(sd.payoutRatio),

    sector:   str(ap.sector),
    industry: str(ap.industry),

    website:      str((ap as any).website),
    employees:    num((ap as any).fullTimeEmployees),
    headquarters: [str((ap as any).city), str((ap as any).state), str((ap as any).country)]
                    .filter(Boolean).join(', ') || null,
    description:  str((ap as any).longBusinessSummary),
    isin,
    wkn: isin?.startsWith('DE0') && isin.length === 12 ? isin.slice(5, 11) : null,

    roic:                null,
    epsGrowth3Y:         null,
    dividendGrowthRate5Y: null,

    receivables: fxc(num(bs.accountsReceivable)),
    ppe:         fxc(num(bs.netPPE)),
    sga:         fxc(num((inc as any).sellingGeneralAndAdministration)),

    tradingCurrency,
    financialCurrency,

    monthlyReturns,

    prevYear,
    fundamentalsHistory,

    shortPercentOfFloat:   num(ks.shortPercentOfFloat),
    shortRatio:            num(ks.shortRatio),
    sharesShort:           num(ks.sharesShort),
    sharesShortPriorMonth: num(ks.sharesShortPriorMonth),

    nextEarningsDate,
    exDividendDate:     toDateStr(sd.exDividendDate) ?? toDateStr(cal.exDividendDate),
    dividendPayDate:    toDateStr(sd.dividendDate)   ?? toDateStr(cal.dividendDate),
    nextDividendAmount: num(cal.dividendAmount) ?? num(sd.dividendRate),

    institutionsPercentHeld: num(mhb.institutionsPercentHeld),
    insidersPercentHeld:     num(mhb.insidersPercentHeld),
    institutionsCount:       num(mhb.institutionsCount),

    earningsSurprises,
    earningsEstimates,
    quarterlyRevenues,

    insiderBuyShares:  insiderBuyCount  > 0 ? insiderBuyShares  : null,
    insiderSellShares: insiderSellCount > 0 ? insiderSellShares : null,
    insiderBuyValue:   insiderBuyCount  > 0 ? insiderBuyValue   : null,
    insiderSellValue:  insiderSellCount > 0 ? insiderSellValue  : null,
    insiderBuyCount:   insiderBuyCount  > 0 ? insiderBuyCount   : null,
    insiderSellCount:  insiderSellCount > 0 ? insiderSellCount  : null,
  };

  return { financials, dailyBars, revisions };
}
