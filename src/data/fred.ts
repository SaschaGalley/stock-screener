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
    // Reject non-finite parses (NaN) so the `?? FALLBACK` guards in
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

export interface MarketRates {
  riskFreeRate: number;    // 10-year Treasury yield (DGS10)
  aaaBondYield: number;    // Moody's Aaa Corporate Bond Yield (DAAA)
}

const FALLBACK: MarketRates = { riskFreeRate: 0.045, aaaBondYield: 0.05 };

/**
 * Process-level memo. These are daily series — refetching them per HTTP request
 * bought nothing but latency, and every stock the web UI opens went through
 * here. In-flight requests are shared too, so N concurrent openers issue one
 * pair of FRED calls, not N.
 *
 * Memory only, deliberately: two numbers are not worth a cache file, and a
 * restart paying ~300ms once is cheaper than reasoning about a stale one.
 */
const RATES_TTL_MS = 60 * 60 * 1000;
let ratesCache: { at: number; rates: MarketRates } | null = null;
let ratesInFlight: Promise<MarketRates> | null = null;

export async function getMarketRates(apiKey: string): Promise<MarketRates> {
  if (ratesCache && Date.now() - ratesCache.at < RATES_TTL_MS) return ratesCache.rates;
  if (ratesInFlight) return ratesInFlight;

  ratesInFlight = (async () => {
    const [rfr, aaa] = await Promise.all([
      fetchLatestDecimal('DGS10', apiKey),
      fetchLatestDecimal('DAAA', apiKey),
    ]);

    const rates: MarketRates = {
      riskFreeRate: rfr ?? FALLBACK.riskFreeRate,
      aaaBondYield: aaa ?? FALLBACK.aaaBondYield,
    };

    logger.debug(`FRED rates — 10Y Treasury: ${(rates.riskFreeRate * 100).toFixed(2)}%, AAA: ${(rates.aaaBondYield * 100).toFixed(2)}%`);
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
