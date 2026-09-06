import { getImpliedERP } from './damodaran.js';
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
    // Reject non-finite parses (NaN) so the `?? FALLBACK_RATES` guards in
    // getMarketRates actually engage — NaN is neither null nor undefined.
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
 * Everything the valuation models discount with. Two of the three come from
 * FRED; the equity risk premium is Damodaran's implied series (see
 * `data/damodaran.ts`) and is grouped here because it is the same kind of
 * thing — a market-wide input, refetched rather than assumed.
 */
export interface MarketRates {
  riskFreeRate:      number;   // 10-year Treasury yield (DGS10)
  aaaBondYield:      number;   // Moody's Aaa Corporate Bond Yield (DAAA)
  equityRiskPremium: number;   // Damodaran implied ERP, trailing 12 month
}

/**
 * What to discount with when a feed is unreachable. Exported because the models
 * need the same numbers when they run without rates at all (an overview row
 * built from stored financials, a CLI run with no FRED key), and two copies of
 * a fallback drift apart exactly when nobody is looking.
 */
export const FALLBACK_RATES: MarketRates = {
  riskFreeRate:      0.045,
  aaaBondYield:      0.05,
  equityRiskPremium: 0.055,   // Damodaran's long-run mature-market average
};

/**
 * Process-level memo. These are daily series — refetching them per HTTP request
 * bought nothing but latency, and every stock the web UI opens went through
 * here. In-flight requests are shared too, so N concurrent openers issue one
 * round of upstream calls, not N. (The monthly ERP keeps its own, longer memo
 * in `damodaran.ts`, so this hourly one doesn't re-download a spreadsheet.)
 *
 * Memory only, deliberately: three numbers are not worth a cache file, and a
 * restart paying ~300ms once is cheaper than reasoning about a stale one.
 */
const RATES_TTL_MS = 60 * 60 * 1000;
let ratesCache: { at: number; rates: MarketRates } | null = null;
let ratesInFlight: Promise<MarketRates> | null = null;

export async function getMarketRates(apiKey: string): Promise<MarketRates> {
  if (ratesCache && Date.now() - ratesCache.at < RATES_TTL_MS) return ratesCache.rates;
  if (ratesInFlight) return ratesInFlight;

  ratesInFlight = (async () => {
    const [rfr, aaa, erp] = await Promise.all([
      fetchLatestDecimal('DGS10', apiKey),
      fetchLatestDecimal('DAAA', apiKey),
      getImpliedERP(),
    ]);

    const rates: MarketRates = {
      riskFreeRate:      rfr ?? FALLBACK_RATES.riskFreeRate,
      aaaBondYield:      aaa ?? FALLBACK_RATES.aaaBondYield,
      equityRiskPremium: erp?.premium ?? FALLBACK_RATES.equityRiskPremium,
    };

    logger.debug(`Market rates — 10Y Treasury: ${(rates.riskFreeRate * 100).toFixed(2)}%, AAA: ${(rates.aaaBondYield * 100).toFixed(2)}%, implied ERP: ${(rates.equityRiskPremium * 100).toFixed(2)}%${erp?.asOf ? ` (${erp.asOf})` : ''}`);
    ratesCache = { at: Date.now(), rates };
    return rates;
  })();

  try {
    return await ratesInFlight;
  } finally {
    // Cleared on failure too — a transient FRED outage must not pin the app to
    // the fallback constants for an hour.
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
