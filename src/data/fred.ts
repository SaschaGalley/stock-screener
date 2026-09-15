import { getImpliedERP } from './damodaran.js';
import { CreditSpreads, FALLBACK_SPREADS, RATING_BUCKETS } from './ratings.js';
import { logger } from '../utils/logger.js';

const BASE = 'https://api.stlouisfed.org/fred/series/observations';

/** Fetch the most recent non-missing observation; returns the raw numeric value as published. */
async function fetchLatestRaw(seriesId: string, apiKey: string): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: apiKey,
      limit: '5',           // fetch a few in case the most recent is null
      sort_order: 'desc',
      file_type: 'json',
    });
    const res = await fetch(`${BASE}?${params}`, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
    const data = await res.json() as { observations?: Array<{ value: string }> };
    const value = data.observations?.find((o) => o.value !== '.')?.value;
    // Reject non-finite parses (NaN) so a garbage value counts as unread in
    // getMarketRates — NaN is neither null nor undefined.
    const n = value != null ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    logger.warn(`FRED[${seriesId}]: ${(e as Error).message}`);
    return null;
  }
}

async function fetchLatestDecimal(seriesId: string, apiKey: string): Promise<number | null> {
  const raw = await fetchLatestRaw(seriesId, apiKey);
  return raw === null ? null : raw / 100;
}

/**
 * Ten-year government yields for cash flows that aren't in dollars: the OECD's
 * monthly long-term rate series on FRED, published about three months behind.
 * The euro uses the Bund — the euro-area aggregate folds in Italian and Spanish
 * credit spreads, and a risk-free rate must not carry any.
 */
export const LOCAL_TEN_YEAR = {
  EUR: 'IRLTLT01DEM156N',
  GBP: 'IRLTLT01GBM156N',
  CHF: 'IRLTLT01CHM156N',
  JPY: 'IRLTLT01JPM156N',
  CAD: 'IRLTLT01CAM156N',
  AUD: 'IRLTLT01AUM156N',
  SEK: 'IRLTLT01SEM156N',
  NOK: 'IRLTLT01NOM156N',
  DKK: 'IRLTLT01DKM156N',
  KRW: 'IRLTLT01KRM156N',
} as const;

export type RateCurrency = keyof typeof LOCAL_TEN_YEAR;
export const RATE_CURRENCIES = Object.keys(LOCAL_TEN_YEAR) as RateCurrency[];

/**
 * Everything the valuation models discount with. The yields and spreads come
 * from FRED; the equity risk premium is Damodaran's implied series (see
 * `data/damodaran.ts`) and is grouped here because it is the same kind of
 * thing — a market-wide input, refetched rather than assumed.
 */
export interface MarketRates {
  riskFreeRate:       number;                                 // 10-year Treasury (DGS10) — the stock's own currency after ratesForCurrency
  aaaBondYield:       number;                                 // Moody's Aaa corporate bond yield (DAAA)
  equityRiskPremium:  number;                                 // Damodaran implied ERP, trailing 12 month
  creditSpreads:      CreditSpreads;                          // ICE BofA option-adjusted spread per rating bucket
  localRiskFreeRates: Partial<Record<RateCurrency, number>>;  // ten-year government yields for non-dollar cash flows
}

/**
 * The part of a reading that was actually read this time. Anything else in a
 * `FetchedRates` is an earlier reading or a fallback constant, and recording it
 * as today's observation would quietly splice assumptions into a market series.
 */
export interface ObservedRates {
  riskFreeRate?:      number;
  aaaBondYield?:      number;
  equityRiskPremium?: number;
  creditSpreads:      Partial<CreditSpreads>;
  localRiskFreeRates: Partial<Record<RateCurrency, number>>;
}

/** What `getMarketRates` hands out: complete rates for the models, plus which of them are news. */
export interface FetchedRates extends MarketRates {
  observed: ObservedRates;
}

/**
 * What to discount with before a feed has ever answered. Exported because the
 * models need the same numbers when they run without rates at all (an overview
 * row built from stored financials), and two copies of a fallback drift apart
 * exactly when nobody is looking.
 */
export const FALLBACK_RATES: MarketRates = {
  riskFreeRate:       0.045,
  aaaBondYield:       0.05,
  equityRiskPremium:  0.055,               // Damodaran's long-run mature-market average
  creditSpreads:      FALLBACK_SPREADS,
  localRiskFreeRates: {},                  // non-dollar stocks keep the dollar rate
};

/**
 * The rates for a stock whose cash flows are in `currency`: the risk-free leg
 * becomes that currency's ten-year government yield. Everything the models
 * build on it follows — cost of equity and of debt, and the terminal-growth cap,
 * since a euro business grows at euro nominal rates.
 *
 * The premium and the spreads stay American: Damodaran's implied ERP is the
 * mature-market premium he applies everywhere before country risk, and ICE's
 * dollar indices are the deep market for rating spreads. A currency without a
 * FRED series keeps the dollar rate, as every stock did before. Yahoo quotes
 * London in pence ("GBp"); upper-casing turns that into the pound.
 */
export function ratesForCurrency<R extends MarketRates>(rates: R, currency: string | null | undefined): R {
  const local = currency ? rates.localRiskFreeRates[currency.toUpperCase() as RateCurrency] : undefined;
  return local === undefined ? rates : { ...rates, riskFreeRate: local };
}

/**
 * Process-level memo. These are daily series — refetching them per HTTP request
 * bought nothing but latency, and every stock the web UI opens went through
 * here. In-flight requests are shared too, so N concurrent openers issue one
 * round of upstream calls, not N. (The monthly ERP keeps its own, longer memo
 * in `damodaran.ts`, so this hourly one doesn't re-download a spreadsheet.)
 *
 * A complete reading is kept for the hour, an incomplete one for minutes. The
 * premium's memo used to keep a timeout for twelve hours, and the nightly run
 * recorded the constant it fell back to as that day's value.
 *
 * Memory only, deliberately: a handful of numbers is not worth a cache file,
 * and a restart paying ~300ms once is cheaper than reasoning about a stale one.
 */
const RATES_TTL_MS   = 60 * 60 * 1000;
const RETRY_AFTER_MS = 5 * 60 * 1000;

/** Newest live value of every rate this process has read — a failed series falls back to it before the constants. */
let lastObserved: ObservedRates = { creditSpreads: {}, localRiskFreeRates: {} };
let ratesCache: { at: number; complete: boolean; rates: FetchedRates } | null = null;
let ratesInFlight: Promise<FetchedRates> | null = null;

/**
 * Current rates. Without a FRED key the FRED series aren't failing, they
 * aren't asked for: the premium, which needs no key, is still read, and only
 * it counts towards a complete reading.
 */
export async function getMarketRates(apiKey?: string | null): Promise<FetchedRates> {
  if (ratesCache && Date.now() - ratesCache.at < (ratesCache.complete ? RATES_TTL_MS : RETRY_AFTER_MS)) {
    return ratesCache.rates;
  }
  if (ratesInFlight) return ratesInFlight;

  ratesInFlight = (async () => {
    const fred = (seriesId: string) => (apiKey ? fetchLatestDecimal(seriesId, apiKey) : Promise.resolve(null));
    const [rfr, aaa, erp, spreads, locals] = await Promise.all([
      fred('DGS10'),
      fred('DAAA'),
      getImpliedERP(),
      Promise.all(RATING_BUCKETS.map((b) => fred(b.fredSeries))),
      Promise.all(RATE_CURRENCIES.map((c) => fred(LOCAL_TEN_YEAR[c]))),
    ]);

    const observed: ObservedRates = { creditSpreads: {}, localRiskFreeRates: {} };
    if (rfr !== null) observed.riskFreeRate = rfr;
    if (aaa !== null) observed.aaaBondYield = aaa;
    if (erp !== null) observed.equityRiskPremium = erp.premium;
    RATING_BUCKETS.forEach((b, i) => { const v = spreads[i]; if (v !== null) observed.creditSpreads[b.rating] = v; });
    RATE_CURRENCIES.forEach((c, i) => { const v = locals[i]; if (v !== null) observed.localRiskFreeRates[c] = v; });

    lastObserved = {
      ...lastObserved,
      ...observed,
      creditSpreads:      { ...lastObserved.creditSpreads, ...observed.creditSpreads },
      localRiskFreeRates: { ...lastObserved.localRiskFreeRates, ...observed.localRiskFreeRates },
    };

    const rates: FetchedRates = {
      riskFreeRate:       lastObserved.riskFreeRate      ?? FALLBACK_RATES.riskFreeRate,
      aaaBondYield:       lastObserved.aaaBondYield      ?? FALLBACK_RATES.aaaBondYield,
      equityRiskPremium:  lastObserved.equityRiskPremium ?? FALLBACK_RATES.equityRiskPremium,
      creditSpreads:      { ...FALLBACK_RATES.creditSpreads, ...lastObserved.creditSpreads },
      localRiskFreeRates: { ...lastObserved.localRiskFreeRates },
      observed,
    };

    const expected = 1 + (apiKey ? 2 + RATING_BUCKETS.length + RATE_CURRENCIES.length : 0);
    const read = [observed.riskFreeRate, observed.aaaBondYield, observed.equityRiskPremium].filter((v) => v !== undefined).length
      + Object.keys(observed.creditSpreads).length
      + Object.keys(observed.localRiskFreeRates).length;
    const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
    logger.debug(
      `Market rates — ${read}/${expected} read: 10Y Treasury ${pct(rates.riskFreeRate)}, AAA ${pct(rates.aaaBondYield)}, `
      + `implied ERP ${pct(rates.equityRiskPremium)}${erp?.asOf ? ` (${erp.asOf})` : ''}, BBB spread ${pct(rates.creditSpreads.BBB)}`,
    );

    ratesCache = { at: Date.now(), complete: read === expected, rates };
    return rates;
  })();

  try {
    return await ratesInFlight;
  } finally {
    ratesInFlight = null;
  }
}

export interface MacroSpreads {
  yieldCurve2Y10YBps: number | null;  // T10Y2Y, published in percentage points → ×100 for bps
  hySpreadBps:        number | null;  // BAMLH0A0HYM2, percent → ×100 for bps
}

export async function getMacroSpreads(apiKey: string): Promise<MacroSpreads> {
  const [t10y2y, hy] = await Promise.all([
    fetchLatestRaw('T10Y2Y',         apiKey),
    fetchLatestRaw('BAMLH0A0HYM2',   apiKey),
  ]);

  return {
    yieldCurve2Y10YBps: t10y2y === null ? null : t10y2y * 100,
    hySpreadBps:        hy     === null ? null : hy     * 100,
  };
}
