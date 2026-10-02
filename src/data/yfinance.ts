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
import { auditFinancials, isFundamentalsStale } from '../analysis/data-quality.js';
import { QuarterPoint, annualGrowth, latestValue, trailingGrowth, trailingSum } from '../analysis/trailing.js';
import { MINOR_UNIT_CURRENCIES } from '../currencies.js';
import { logger } from '../utils/logger.js';
import {
  analystActionsFrom, insiderTransactionsFrom, pickModules, priceBarsFrom, priceEventsFrom,
  type PriceBarRow, type PriceEventRow, type YahooRaw,
} from './yahoo-raw.js';
import { toFiniteNumber as num } from '../utils/num.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false, logOptionsErrors: false } } as any);

/**
 * How far Yahoo's reported enterprise value may sit from `marketCap + net debt`
 * before we replace it with the identity. Wide enough to absorb Yahoo's own
 * as-of-date drift between the quote and the balance sheet, narrow enough to
 * reject a figure that is off by a factor.
 */
const EV_IDENTITY_TOLERANCE = 0.15;


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

const SUMMARY_MODULES = [
  'financialData', 'defaultKeyStatistics', 'summaryDetail', 'assetProfile', 'price',
  'recommendationTrend', 'earningsHistory', 'earningsTrend', 'insiderTransactions',
  'calendarEvents', 'majorHoldersBreakdown',
] as const;

/**
 * Fetch the summary modules, degrading per module rather than all at once.
 *
 * All eleven in one request is the fast path and normally works. But Yahoo
 * validates the whole response as one object, so a single module coming back in
 * an unexpected shape throws — and the old handler turned that into `null`,
 * silently dropping analyst coverage, ownership, estimates and key statistics
 * together. Air Liquide's Paris line (`AI.PA`) hit exactly this: 20 analysts
 * upstream, zero in our payload, indistinguishable from a genuinely uncovered
 * stock and therefore from the bug this whole change set exists to fix.
 *
 * So on failure, refetch module by module and keep what parses. Slower, but it
 * only runs when the combined request already failed, and losing one module is
 * a far better outcome than losing eleven.
 */
async function safeSummary(symbol: string): Promise<any> {
  try {
    return await yf.quoteSummary(symbol, { modules: SUMMARY_MODULES as unknown as string[] } as any);
  } catch (e) {
    logger.warn(`Summary[combined]: ${(e as Error).message} — refetching per module for ${symbol}`);
  }

  const results = await Promise.all(SUMMARY_MODULES.map(async (m) => {
    try {
      const r = await yf.quoteSummary(symbol, { modules: [m] } as any);
      return [m, (r as any)?.[m] ?? null] as const;
    } catch (e) {
      logger.debug(`Summary[${m}] for ${symbol}: ${(e as Error).message}`);
      return [m, null] as const;
    }
  }));

  const merged: Record<string, unknown> = {};
  const lost: string[] = [];
  for (const [m, value] of results) {
    if (value !== null) merged[m] = value; else lost.push(m);
  }
  if (Object.keys(merged).length === 0) {
    logger.warn(`Summary: every module failed for ${symbol}`);
    return null;
  }
  if (lost.length > 0) logger.warn(`Summary: ${symbol} missing ${lost.join(', ')}`);
  return merged;
}

/**
 * Modules fetched only to be archived — nothing in the payload reads them.
 *
 * A request of their own, and unvalidated: they are stored as Yahoo sends
 * them, and a shape the library does not expect must not cost the payload the
 * eleven modules above, which is what folding them into that request would
 * risk. The analyst history is the one that matters — every rating action and
 * price target change back to 2012 for the large caps.
 */
const ARCHIVE_MODULES = [
  'upgradeDowngradeHistory', 'institutionOwnership', 'fundOwnership', 'insiderHolders', 'netSharePurchaseActivity',
] as const;

async function safeArchiveSummary(symbol: string): Promise<any> {
  try {
    return await yf.quoteSummary(symbol, { modules: ARCHIVE_MODULES as unknown as string[] } as any, { validateResult: false } as any);
  } catch (e) {
    logger.debug(`Summary[archive] for ${symbol}: ${(e as Error).message}`);
    return null;
  }
}

interface HistoricalData {
  monthlyReturns: number[];
  monthlyPrices: Record<string, number>;  // "YYYY-MM" → price
  dailyBars: DailyBar[];
  /** The daily chart as Yahoo sent it, for the price archive. */
  priceBars: PriceBarRow[];
  priceEvents: PriceEventRow[];
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
        events: 'div|split',
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

    return {
      monthlyReturns, monthlyPrices, dailyBars,
      priceBars: priceBarsFrom(dailyQuotes), priceEvents: priceEventsFrom(daily?.events),
    };
  } catch (e) {
    logger.warn(`Historical: ${(e as Error).message}`);
    return { monthlyReturns: [], monthlyPrices: {}, dailyBars: [], priceBars: [], priceEvents: [] };
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
 * Fetch one quarterly statement series, three years deep — eight consecutive
 * quarters are what a trailing-twelve-month growth rate needs, and Yahoo's
 * newest rows are not always complete.
 *
 * The quarters are where the trailing figures come from: revenue for the
 * run-rate ratios, and operating income, free cash flow, interest and stock
 * compensation summed over the last four (`analysis/trailing.ts`), because the
 * ready-made trailing fields in `financialData` define them differently. The
 * newest balance sheet row is the one the equity bridge reads.
 */
async function safeQuarterlySeries(symbol: string, module: 'balance-sheet' | 'financials' | 'cash-flow'): Promise<any[]> {
  try {
    const from = new Date();
    from.setFullYear(from.getFullYear() - 3);
    const data = await yf.fundamentalsTimeSeries(symbol, {
      period1: from.toISOString().slice(0, 10),
      type: 'quarterly',
      module,
    } as any);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    logger.warn(`TimeSeries[${module},quarterly]: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Spot FX with the inverse pair as a second chance. Yahoo does not quote every
 * direction of every cross, and a missing one used to fall through to a rate of
 * 1 — Alibaba's yuan statements read as dollars, 7× too large and still inside
 * every plausibility bound.
 */
async function fetchFxRateEitherWay(from: string, to: string): Promise<number | null> {
  const direct = await fetchFxRate(from, to);
  if (direct !== null) return direct;
  const inverse = await fetchFxRate(to, from);
  return inverse !== null && inverse > 0 ? 1 / inverse : null;
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

/** What makes one listing of a company better than another to analyse. */
export interface ListingQuality {
  symbol: string;
  /** Newest quarter Yahoo reports for this listing (YYYY-MM-DD), or null. */
  mostRecentQuarter: string | null;
  /** True when that quarter is old enough to poison every trailing ratio. */
  stale: boolean;
  /** Sell-side analysts covering this listing. */
  analystCount: number;
  currency: string | null;
  exchange: string | null;
}

async function listingQuality(symbol: string): Promise<ListingQuality | null> {
  try {
    const [q, sum] = await Promise.all([
      yf.quote(symbol).catch(() => null),
      yf.quoteSummary(symbol, { modules: ['financialData', 'defaultKeyStatistics', 'price'] }).catch(() => null),
    ]);
    if (!q && !sum) return null;
    const ks: any = (sum as any)?.defaultKeyStatistics ?? {};
    const fd: any = (sum as any)?.financialData ?? {};
    const mrq = ks.mostRecentQuarter instanceof Date && !isNaN(ks.mostRecentQuarter.getTime())
      ? ks.mostRecentQuarter.toISOString().slice(0, 10)
      : null;
    return {
      symbol,
      mostRecentQuarter: mrq,
      stale: isFundamentalsStale(mrq, Date.now()),
      analystCount: num(fd.numberOfAnalystOpinions) ?? 0,
      currency: str((q as any)?.currency) ?? str((sum as any)?.price?.currency),
      exchange: str((q as any)?.fullExchangeName),
    };
  } catch {
    return null;
  }
}

/**
 * Find a listing of the same company with data worth analysing.
 *
 * The problem this solves: a company can be quoted on several venues, and Yahoo
 * only maintains the fundamentals behind *some* of them. FACC's London IOB line
 * (`0QW9.IL`) served a market-side block from Q2 2023 and zero analyst coverage,
 * while Vienna (`FACC.VI`) had current statements and four analysts — same
 * company, same currency, one usable and one not. Nothing in the pipeline could
 * tell the difference, because each individual figure looked fine.
 *
 * Returns null when the current listing is already the best available, so the
 * caller can treat a non-null result as "there is something strictly better".
 * Candidates are found by company name, which is what Yahoo's search indexes
 * across venues.
 */
export async function findBetterListing(
  symbol: string,
  companyName: string | null,
): Promise<ListingQuality | null> {
  const current = await listingQuality(symbol);
  if (!current) return null;
  // A fresh, covered listing is not worth replacing, whatever else exists.
  if (!current.stale && current.analystCount > 0) return null;

  const query = companyName ?? symbol;
  let candidates: YFSearchQuote[] = [];
  try {
    candidates = await yahooSearch(query, 10);
  } catch (e) {
    logger.debug(`Listing search for "${query}" failed: ${(e as Error).message}`);
    return null;
  }

  const symbols = candidates
    .filter((c) => c.quoteType === 'EQUITY' && c.symbol && c.symbol !== symbol)
    .map((c) => c.symbol!)
    .slice(0, 6);
  if (symbols.length === 0) return null;

  const probed = (await Promise.all(symbols.map(listingQuality))).filter((x): x is ListingQuality => x !== null);

  // Ranking, in order: usable data first (a stale listing is disqualified no
  // matter how well covered), then coverage depth, then keep the currency the
  // caller already has — switching venues is one change, switching currency is
  // two, and the second silently reinterprets stored price history.
  const better = probed
    .filter((c) => !c.stale)
    .filter((c) => c.analystCount > current.analystCount || (current.stale && c.analystCount >= current.analystCount))
    .sort((a, b) => {
      const sameCur = (c: ListingQuality) => (c.currency === current.currency ? 1 : 0);
      return (b.analystCount - a.analystCount) || (sameCur(b) - sameCur(a));
    })[0];

  return better ?? null;
}

export interface QuoteBrief {
  symbol:    string;
  name:      string | null;
  price:     number | null;
  marketCap: number | null;
  currency:  string | null;
}

/**
 * Name, price and size for several tickers in one request — enough to put a
 * name to a peer the database has never stored. Keyed by the ticker as asked;
 * a ticker Yahoo does not know is simply absent, and a failed request is an
 * empty map rather than an error, since the caller only wanted a label.
 */
export async function quoteBriefs(symbols: string[]): Promise<Map<string, QuoteBrief>> {
  const out = new Map<string, QuoteBrief>();
  if (symbols.length === 0) return out;
  try {
    const quotes = await yf.quote(symbols, { return: 'array' }) as any[];
    for (const q of quotes ?? []) {
      const symbol = str(q?.symbol);
      if (!symbol) continue;
      out.set(symbol.toUpperCase(), {
        symbol:    symbol.toUpperCase(),
        name:      str(q.longName) ?? str(q.shortName),
        price:     num(q.regularMarketPrice),
        marketCap: num(q.marketCap),
        currency:  str(q.currency),
      });
    }
  } catch (e) {
    logger.warn(`Quote briefs for ${symbols.join(',')}: ${(e as Error).message}`);
  }
  return out;
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
  /** Everything fetched that the payload does not carry — for the archive. */
  raw:        YahooRaw;
}

export async function getFinancials(symbol: string): Promise<FinancialsBundle> {
  logger.step(`Fetching financials for ${symbol}...`);

  const [quote, summary, bsData, finData, cfData, finQData, cfQData, bsQData, historicalData, archive] = await Promise.all([
    safeQuote(symbol),
    safeSummary(symbol),
    safeTimeSeries(symbol, 'balance-sheet'),
    safeTimeSeries(symbol, 'financials'),
    safeTimeSeries(symbol, 'cash-flow'),
    safeQuarterlySeries(symbol, 'financials'),
    safeQuarterlySeries(symbol, 'cash-flow'),
    safeQuarterlySeries(symbol, 'balance-sheet'),
    safeHistoricalData(symbol),
    safeArchiveSummary(symbol),
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
  // A minor-unit listing prices in pence but reports market cap, EPS and book
  // value in pounds — `quoteScale` lifts those into the unit the price is in.
  const minorUnit = tradingCurrency ? MINOR_UNIT_CURRENCIES[tradingCurrency] : undefined;
  const quoteScale = minorUnit?.perMajor ?? 1;
  const quoteMajor = minorUnit?.major ?? tradingCurrency;
  // No rate is no conversion — and an unconverted statement is worse than none:
  // every statement figure is withheld and the audit says why.
  let fxRate = quoteScale;
  let fxUnavailable = false;
  if (quoteMajor && financialCurrency && quoteMajor !== financialCurrency) {
    const rate = await fetchFxRateEitherWay(financialCurrency, quoteMajor);
    if (rate === null) fxUnavailable = true;
    else fxRate = rate * quoteScale;
  }
  if (fxRate !== 1) {
    logger.info(`Currency: ${financialCurrency}→${tradingCurrency} statements ×${fxRate.toFixed(4)} for ${symbol}`);
  }
  if (fxUnavailable) {
    logger.warn(`Currency: no ${financialCurrency}→${quoteMajor} rate for ${symbol} — statement figures withheld`);
  }
  /** Convert a statement-currency (reporting) amount into the trading currency. */
  const fxc = (n: number | null): number | null => (n === null || fxUnavailable ? null : n * fxRate);
  /** Convert a {year,value} history series of statement-currency values. */
  const fxcSeries = (s: { year: number; value: number }[]) =>
    fxUnavailable ? [] : fxRate === 1 ? s : s.map((p) => ({ year: p.year, value: p.value * fxRate }));
  /** A market-side figure Yahoo quotes in the major unit, in the unit the price is in. */
  const inQuoteUnit = (n: number | null): number | null => (n === null ? null : n * quoteScale);

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
  // Operating income, not Yahoo's `EBIT` line: that one is pretax income plus
  // interest and so carries every investment gain — Alphabet's FY2025 read
  // 159.6 bn against 129.0 bn of operating income. The history series was
  // already operating income, so the two now agree on what they measure.
  const annualOperatingIncome = num(inc.operatingIncome) ?? num((inc as any).EBIT);
  const grossProfit      = num(inc.grossProfit);
  const interestExpenseAnnual = num(inc.interestExpense)
    ?? num((inc as any).interestExpenseNonOperating);
  const incomeTaxExpense = num(inc.taxProvision);
  const incomeBeforeTax  = num(inc.pretaxIncome);
  // Effective tax rate over the newest three fiscal years together, clamped to a
  // sane band. One year is one audit settlement or one deferred-tax release
  // away from 0 % or 60 %; three summed years are the rate the business
  // actually pays. A tax *benefit* maps to 0, and the ceiling is 35 % so the
  // NOPAT-based models are not distorted by a single distorted year.
  const taxRate = (() => {
    const years = finData.slice(-3)
      .map((r: any) => ({ tax: num(r.taxProvision), pretax: num(r.pretaxIncome) }))
      .filter((y) => y.tax !== null && y.pretax !== null);
    const pretax = years.reduce((s, y) => s + (y.pretax as number), 0);
    const tax = years.reduce((s, y) => s + (y.tax as number), 0);
    const raw = years.length > 0 && pretax > 0 ? tax / pretax
      : incomeTaxExpense !== null && incomeBeforeTax !== null && incomeBeforeTax > 0 ? incomeTaxExpense / incomeBeforeTax
      : null;
    return raw !== null ? Math.max(0, Math.min(raw, 0.35)) : null;
  })();

  // ── Cash flow ─────────────────────────────────────────────────────────────
  const operatingCashFlowAnnual = num(cf.operatingCashFlow);
  const capexRaw = num(cf.capitalExpenditure);
  const capexAnnual = capexRaw !== null ? Math.abs(capexRaw) : null;
  const depreciation = num((cf as any).depreciationAndAmortization)
    ?? num((cf as any).depreciation);
  // Where interest paid is classified. IFRS lets a filer put it under operating
  // or financing activities (AIR.PA: operating, ENR.DE and AI.PA: financing);
  // US GAAP keeps it in operating and discloses it supplementally.
  const interestInOperatingCashFlow =
    num((cf as any).interestPaidCFF) !== null ? false
    : num((cf as any).interestPaidCFO) !== null || num((cf as any).interestPaidSupplementalData) !== null ? true
    : null;

  // Share counts for Piotroski F7, one measure for both years: diluted average
  // shares where both years report them, basic otherwise. Comparing diluted to
  // basic would count option dilution as an issuance.
  const shareCounts = (['dilutedAverageShares', 'basicAverageShares'] as const)
    .map((key) => ({ now: num((inc as any)[key]), prev: inc1 ? num((inc1 as any)[key]) : null }))
    .find((c) => c.now !== null && c.prev !== null) ?? null;

  // What options, RSUs and convertibles add to the share count: diluted over
  // basic weighted-average shares for the newest fiscal year. Per-share values
  // are on the basic count the price is quoted against, and this lifts them to
  // the count the equity actually has to be shared between.
  const dilutedShareRatio = (() => {
    const diluted = num((inc as any).dilutedAverageShares);
    const basic = num((inc as any).basicAverageShares);
    return diluted !== null && basic !== null && basic > 0 && diluted >= basic
      ? Math.min(diluted / basic, 1.2) : null;
  })();

  // ── Trailing twelve months, from the quarterly statements ─────────────────
  const quarterEnd = (row: any): string | null => {
    const raw = row?.date ?? row?.asOfDate ?? row?.endDate;
    const d: Date | null = raw instanceof Date ? raw
      : typeof raw === 'string' ? new Date(raw)
      : typeof raw === 'number' ? new Date(raw * 1000) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  };
  /** One quarterly statement line, oldest first, one point per quarter end. */
  const quarterly = (rows: any[], pick: (row: any) => number | null): QuarterPoint[] => {
    const byEnd = new Map<string, number>();
    for (const row of rows) {
      const end = quarterEnd(row);
      const v = pick(row);
      if (end !== null && v !== null) byEnd.set(end, v);
    }
    return [...byEnd.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([endDate, value]) => ({ endDate, value }));
  };
  const trailing = (rows: any[], pick: (row: any) => number | null): number | null => trailingSum(quarterly(rows, pick));

  const operatingIncomeTTM = trailing(finQData, (r) => num(r.operatingIncome));
  const netIncomeQuarters  = quarterly(finQData, (r) => num(r.netIncomeCommonStockholders) ?? num(r.netIncome));
  const normalizedIncomeTTM = trailing(finQData, (r) => num(r.normalizedIncome));
  const interestTTM        = trailing(finQData, (r) => num(r.interestExpense) ?? num(r.interestExpenseNonOperating));
  // Free cash flow as the statements define it — operating cash flow less
  // capex — never `financialData.freeCashflow`, which is S&P's levered free cash
  // flow and not this at all.
  const fcfTTM     = trailing(cfQData, (r) => num(r.freeCashFlow)
    ?? (num(r.operatingCashFlow) !== null && num(r.capitalExpenditure) !== null
      ? (num(r.operatingCashFlow) as number) - Math.abs(num(r.capitalExpenditure) as number) : null));
  const ocfTTM     = trailing(cfQData, (r) => num(r.operatingCashFlow));
  const capexTTM   = trailing(cfQData, (r) => { const v = num(r.capitalExpenditure); return v === null ? null : Math.abs(v); });
  const sbcTTM     = trailing(cfQData, (r) => num(r.stockBasedCompensation));
  const daTTM      = trailing(cfQData, (r) => num(r.depreciationAndAmortization) ?? num(r.depreciation));
  const revenueQuarters = quarterly(finQData, (r) => num(r.totalRevenue) ?? num(r.revenue));

  // ── Newest balance sheet ──────────────────────────────────────────────────
  // The quarter-end sheet when there is one at least as new as the annual one.
  const bsQ = (() => {
    const q = [...bsQData].sort((a, b) => (quarterEnd(a) ?? '').localeCompare(quarterEnd(b) ?? '')).at(-1);
    const qEnd = q ? quarterEnd(q) : null;
    const aEnd = quarterEnd(bs);
    return q && qEnd !== null && (aEnd === null || qEnd >= aEnd) ? q : bs;
  })() as any;
  const commonEquity   = num(bsQ.commonStockEquity) ?? num(bsQ.stockholdersEquity);
  const minorityInterest = num(bsQ.minorityInterest);
  const preferredEquity  = num(bsQ.preferredStockEquity) ?? num(bsQ.preferredStock);
  // Investments the operating income does not earn on: non-current marketable
  // securities (Apple's 84 bn) and stakes carried outside the business
  // (Alphabet's 131 bn, whose revaluations Yahoo's EBIT line used to count).
  const nonOperatingAssets = num(bsQ.investmentsAndAdvances) ?? num(bsQ.longTermEquityInvestment);
  const leaseObligations = num(bsQ.capitalLeaseObligations);

  // ── Earnings surprises ────────────────────────────────────────────────────
  const earningsSurprises = (eh as any[]).slice(0, 4).map((q: any) => ({
    quarter:     str(q.period) ?? str(q.quarter?.fmt) ?? 'Unknown',
    // The label is relative ("-4q"); the quarter's end is what places it on a
    // calendar, and without it no surprise ever reached the fiscal table.
    endDate:     q.quarter instanceof Date && !Number.isNaN(q.quarter.getTime())
                   ? q.quarter.toISOString().slice(0, 10)
                   : null,
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
      sharesOutstanding:  shareCounts?.prev ?? null,
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
    normalizedIncome:   fxcSeries(series(finData, (r) => num((r as any).normalizedIncome))),
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

  // ── Freshness of the market-side modules ─────────────────────────────────
  // `quote` and `financialData` are a different data path from the statement
  // series, and Yahoo does not age them together. On a thin secondary listing
  // it will happily keep serving a `financialData` block from years ago next to
  // current statements — FACC's London IOB line (0QW9.IL) sat at Q2 2023 while
  // Vienna was at Q1 2026. Since every TTM ratio in the payload comes from that
  // block, a stale one silently poisons P/E, margins, ROE, FCF and EV at once.
  //
  // So: date the block, and when it is too old, take the consistency-critical
  // figures from the statements instead. Yahoo's TTM is genuinely better than an
  // annual figure when it is current, which is why this is a fallback and not
  // the default — a healthy ticker keeps the TTM view it had before.
  const isoDay = (v: unknown): string | null => {
    const d = v instanceof Date ? v : typeof v === 'string' || typeof v === 'number' ? new Date(v as any) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  };
  const mostRecentQuarter = isoDay(ks.mostRecentQuarter);
  const lastFiscalYearEnd = isoDay(ks.lastFiscalYearEnd);
  const fundamentalsStale = isFundamentalsStale(mostRecentQuarter, Date.now());
  if (fundamentalsStale) {
    logger.warn(
      `${symbol}: Yahoo's market-side modules are stale (newest quarter ${mostRecentQuarter}) — `
      + `falling back to the annual statements for revenue/EPS/margins/EV. Consider the primary listing.`,
    );
  }


  /**
   * Pick between the market-side (TTM) figure and the statement-derived one.
   * Fresh: TTM wins, as before. Stale: the statement wins when it exists.
   */
  const preferStatement = <T>(ttm: T | null, statement: T | null): T | null =>
    fundamentalsStale && statement !== null ? statement : ttm ?? statement;

  const statementRevenue   = latestValue(fundamentalsHistory.revenue);
  const statementNetIncome = latestValue(fundamentalsHistory.netIncome);
  const statementEps       = latestValue(fundamentalsHistory.eps);

  // ── The market side, in the unit the price is quoted in ───────────────────
  const price     = num(quote?.regularMarketPrice) ?? 0;
  const marketCap = inQuoteUnit(num(quote?.marketCap)) ?? 0;
  const quoteEps  = inQuoteUnit(num(quote?.epsTrailingTwelveMonths));

  /**
   * The shares the market cap is spread over, counted in the unit the price is
   * quoted per: every share class, and ADR units for an ADR. Yahoo's
   * `sharesOutstanding` counts one class — Alphabet's class A alone (5.87 bn of
   * 12.23 bn), Berkshire's B shares without the A shares, Novo's B shares
   * without the A — and every firm-level value divided by it came out 2.08×
   * too high for Alphabet. Market cap over price is the count the quote itself
   * implies, whatever the listing.
   */
  const shares = marketCap > 0 && price > 0
    ? marketCap / price
    : num(ks.impliedSharesOutstanding) ?? num(ks.sharesOutstanding);

  // ── Trailing flows: four summed quarters, else the newest fiscal year ─────
  // In statement currency until the payload converts them below.
  const statementFcfRaw = num((cf as any).freeCashFlow)
    ?? (operatingCashFlowAnnual !== null ? operatingCashFlowAnnual - (capexAnnual ?? 0) : null);
  const trailingFcf  = fcfTTM ?? statementFcfRaw;
  const trailingEbit = operatingIncomeTTM ?? annualOperatingIncome;
  const trailingSource: 'quarters' | 'annual' = fcfTTM !== null && operatingIncomeTTM !== null ? 'quarters' : 'annual';

  // Resolve the parallel ISIN lookup. By the time we get here the parsing
  // above has been doing its work in parallel, so this rarely blocks.
  const isin = await isinPromise;

  const financials: StockFinancials = {
    symbol: symbol.toUpperCase(),
    companyName: str(pr.longName) ?? str(pr.shortName) ?? symbol,
    price,
    marketCap,

    // A stale quote's trailingPE is built on a stale EPS, so recompute it from
    // whichever EPS we actually end up trusting rather than shipping a ratio
    // whose numerator and denominator come from different years.
    peRatio:     (() => {
      const e = preferStatement(quoteEps, statementEps);
      if (fundamentalsStale && e !== null && e > 0 && price > 0) return price / e;
      const v = num(quote?.trailingPE);
      return v !== null && v > 0 ? v : null;
    })(),
    forwardPE:   (() => { const v = num(quote?.forwardPE);  return v !== null && v > 0 ? v : null; })(),
    avgPE5Y,
    pegRatio:    num(ks.pegRatio),
    eps:         preferStatement(quoteEps, statementEps),
    // Common equity on the newest balance sheet over the shares the price is
    // quoted per. `ks.bookValue` is per share of whichever class Yahoo counted:
    // Berkshire's B line carried the A share's 522,226, BP's the ordinary
    // share's a sixth of an ADS.
    bookValue:   (() => {
      const equity = fxc(commonEquity) ?? latestValue(fundamentalsHistory.stockholdersEquity);
      return equity !== null && shares !== null && shares > 0 ? equity / shares : null;
    })(),

    // Each of these is a ratio Yahoo computed inside the market-side block. When
    // that block is stale they are not merely old but inconsistent with the
    // statement figures shipped alongside them, so recompute from the statements.
    roe:              preferStatement(
                        num(fd.returnOnEquity),
                        (() => {
                          const eq = latestValue(fundamentalsHistory.stockholdersEquity);
                          return statementNetIncome !== null && eq !== null && eq > 0 ? statementNetIncome / eq : null;
                        })(),
                      ),
    roa:              preferStatement(
                        num(fd.returnOnAssets),
                        (() => {
                          const ta = latestValue(fundamentalsHistory.totalAssets);
                          return statementNetIncome !== null && ta !== null && ta > 0 ? statementNetIncome / ta : null;
                        })(),
                      ),
    operatingMargin:  preferStatement(
                        num(fd.operatingMargins) ?? num(quote?.operatingMargins),
                        (() => {
                          const oi = latestValue(fundamentalsHistory.operatingIncome);
                          return oi !== null && statementRevenue !== null && statementRevenue > 0 ? oi / statementRevenue : null;
                        })(),
                      ),
    netMargin:        preferStatement(
                        num(fd.profitMargins),
                        statementNetIncome !== null && statementRevenue !== null && statementRevenue > 0
                          ? statementNetIncome / statementRevenue : null,
                      ),
    // The trailing twelve months against the twelve before them, from the
    // quarters; else the two newest fiscal years. Yahoo's own fields compare one
    // quarter with the same quarter a year earlier — Apple "grew" 16.4 % in a
    // year that grew 6.4 %.
    revenueGrowth:    trailingGrowth(revenueQuarters) ?? annualGrowth(fundamentalsHistory.revenue),
    revenueGrowthYoY: trailingGrowth(revenueQuarters) ?? annualGrowth(fundamentalsHistory.revenue),
    earningsGrowth:   trailingGrowth(netIncomeQuarters) ?? annualGrowth(fundamentalsHistory.netIncome),

    freeCashFlow:      fxc(trailingFcf),
    operatingCashFlow: fxc(ocfTTM ?? preferStatement(num(fd.operatingCashflow), operatingCashFlowAnnual)),
    // Yahoo's market-side debt and cash include the current portions the
    // quarterly sheet sometimes leaves out, so they lead — unless that block is
    // stale, when the balance sheet is the newer truth.
    totalCash:         fxc(preferStatement(num(fd.totalCash),
                         num(bsQ.cashCashEquivalentsAndShortTermInvestments) ?? num((bs as any).cashCashEquivalentsAndShortTermInvestments))),
    totalDebt:         fxc(preferStatement(num(fd.totalDebt), num(bsQ.totalDebt) ?? num(bs.totalDebt))),
    longTermDebt:      fxc(longTermDebt),
    // Yahoo reports this one in percent (Alphabet's 18.86 is 0.19×).
    debtToEquity:      (() => { const v = num(fd.debtToEquity); return v === null ? null : v / 100; })(),
    currentRatio:      num(fd.currentRatio),
    quickRatio:        num(fd.quickRatio),
    // A ratio of two statement figures, so no FX conversion.
    deferredRevenueShare: (() => {
      const dr = num((bs as any).currentDeferredRevenue);
      return dr !== null && totalCurrentLiabilities !== null && totalCurrentLiabilities > 0
        ? dr / totalCurrentLiabilities : null;
    })(),

    revenue:          preferStatement(fxc(num(fd.totalRevenue)), statementRevenue ?? fxc(num(inc.totalRevenue))),
    grossProfit:      fxc(num(fd.grossProfits) ?? grossProfit),
    ebit:             fxc(trailingEbit),
    netIncome:        preferStatement(fxc(num(fd.netIncomeToCommon)), statementNetIncome ?? fxc(num(inc.netIncome))),
    normalizedNetIncome: fxc(normalizedIncomeTTM ?? num((inc as any).normalizedIncome)),
    // EBITDA = operating income + D&A, both over the same four quarters. Yahoo's
    // figure lives in the market-side block, so pairing a stale one with a
    // current statement EBIT is what produced an EBITDA *below* EBIT —
    // arithmetically impossible, and nothing caught it.
    ebitda:           operatingIncomeTTM !== null && daTTM !== null
                        ? fxc(operatingIncomeTTM + daTTM)
                        : preferStatement(
                            fxc(num(fd.ebitda)),
                            annualOperatingIncome !== null ? fxc(annualOperatingIncome + (depreciation ?? 0)) : null,
                          ),
    interestExpense:  fxc(interestTTM ?? interestExpenseAnnual),
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
    capex:                   fxc(capexTTM ?? capexAnnual),
    depreciation:            fxc(depreciation),
    stockBasedCompensation:  fxc(sbcTTM ?? num((cf as any).stockBasedCompensation)),
    trailingSource,

    // The rest of the equity bridge, from the newest balance sheet.
    minorityInterest:   fxc(minorityInterest),
    preferredEquity:    fxc(preferredEquity),
    nonOperatingAssets: fxc(nonOperatingAssets),
    leaseObligations:   fxc(leaseObligations),
    investedCapital:    fxc(num(bsQ.investedCapital)),
    tangibleBookValue:  fxc(num(bsQ.tangibleBookValue)),
    dilutedShareRatio,

    // EV = trading-currency market cap + converted net debt.
    //
    // Two ways Yahoo's own `ks.enterpriseValue` goes wrong, and both used to be
    // shipped unchecked whenever the currencies happened to match:
    //   - mismatched currencies mix a $-market-cap with ¥-debt (the original
    //     reason this branch exists);
    //   - a stale market-side block reports an EV from an older, smaller market
    //     cap — FACC's London line served 483M against a 858M cap on +226M net
    //     debt, i.e. an EV *below* equity value, which cannot happen.
    //
    // So rather than deciding by currency, compute the identity and use Yahoo's
    // figure only when it agrees with it. Same result as before for a healthy
    // same-currency ticker, without trusting the field on faith.
    enterpriseValue:   (() => {
      // marketCap is already in the trading unit; never FX-scale it. Only the
      // debt and cash legs get converted.
      const reported = num(ks.enterpriseValue);
      if (!(marketCap > 0)) return reported;

      const debt = fxc(preferStatement(num(fd.totalDebt), num(bsQ.totalDebt) ?? num(bs.totalDebt))) ?? 0;
      const cash = fxc(preferStatement(num(fd.totalCash),
        num(bsQ.cashCashEquivalentsAndShortTermInvestments) ?? num((bs as any).cashCashEquivalentsAndShortTermInvestments))) ?? 0;
      const derived = marketCap + debt - cash;

      // Mismatched currencies or units: Yahoo's figure mixes bases and is
      // unusable regardless of how close it looks.
      if (fxRate !== 1) return derived;
      if (reported === null) return derived;

      const off = Math.abs(reported - derived) / Math.max(Math.abs(reported), Math.abs(derived));
      return off > EV_IDENTITY_TOLERANCE ? derived : reported;
    })(),
    sharesOutstanding: shares,
    sharesOutstandingAnnual: shareCounts?.now ?? null,
    interestInOperatingCashFlow,
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
    country:      str((ap as any).country),
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
    nextDividendAmount: inQuoteUnit(num(cal.dividendAmount) ?? num(sd.dividendRate)),

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

    mostRecentQuarter,
    lastFiscalYearEnd,
    fundamentalsStale,
    // Filled in below: the audit needs the assembled payload to compare fields
    // against each other.
    dataQualityWarnings: [],
  };

  // ── Cross-field audit ─────────────────────────────────────────────────────
  // Runs on the finished payload, because every check is a comparison between
  // two fields that individually look fine. Findings ride along into the prompt.
  financials.dataQualityWarnings = auditFinancials(financials);
  if (fxUnavailable) {
    financials.dataQualityWarnings.unshift({
      code: 'fx-unavailable',
      severity: 'error',
      fields: ['financialCurrency'],
      message: `No ${financialCurrency}→${quoteMajor} exchange rate could be read, in either direction. The statements `
        + `report in ${financialCurrency} and the price is quoted in ${tradingCurrency}, so every statement figure has been `
        + `withheld rather than read in the wrong currency — the models that need them abstain.`,
    });
  }

  // When the problem is the *listing* rather than the company, name the ticker
  // that fixes it. Costs a search plus a few probes, so it only runs on a
  // payload that already came back degraded — never on a healthy one.
  const degraded = financials.dataQualityWarnings.some(
    (w) => w.code === 'stale-fundamentals' || w.code === 'no-analyst-coverage',
  );
  if (degraded) {
    const better = await findBetterListing(symbol, financials.companyName);
    if (better) {
      const suffix = better.currency && better.currency !== tradingCurrency
        ? ` Note: it trades in ${better.currency} rather than ${tradingCurrency}, so switching reinterprets stored price history.`
        : '';
      financials.dataQualityWarnings.push({
        code: 'better-listing-available',
        severity: 'warn',
        fields: ['symbol'],
        message: `${better.symbol} (${better.exchange ?? 'unknown venue'}) is the same company with `
          + `${better.analystCount} analyst${better.analystCount === 1 ? '' : 's'} and fundamentals through `
          + `${better.mostRecentQuarter ?? 'an unknown quarter'}. Analyse that listing instead.${suffix}`,
      });
    }
  }

  for (const w of financials.dataQualityWarnings) {
    const line = `${symbol}: [${w.code}] ${w.message}`;
    if (w.severity === 'error') logger.warn(line); else logger.info(line);
  }

  const raw: YahooRaw = {
    priceBars:   historicalData.priceBars,
    priceEvents: historicalData.priceEvents,
    statements: {
      annual:    { balanceSheet: bsData, financials: finData, cashFlow: cfData },
      quarterly: { balanceSheet: bsQData, financials: finQData, cashFlow: cfQData },
    },
    analyst: pickModules(summary, ['recommendationTrend', 'earningsTrend', 'earningsHistory', 'calendarEvents']),
    holders: {
      ...pickModules(summary, ['majorHoldersBreakdown']),
      ...pickModules(archive, ['institutionOwnership', 'fundOwnership', 'insiderHolders', 'netSharePurchaseActivity']),
    },
    analystActions:      analystActionsFrom(archive?.upgradeDowngradeHistory),
    insiderTransactions: insiderTransactionsFrom(summary?.insiderTransactions),
  };

  return { financials, dailyBars, revisions, raw };
}
