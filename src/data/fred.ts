import { logger } from '../utils/logger.js';

const BASE = 'https://api.stlouisfed.org/fred/series/observations';

async function fetchLatest(seriesId: string, apiKey: string): Promise<number | null> {
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
    return value ? parseFloat(value) / 100 : null;
  } catch (e) {
    logger.warn(`FRED[${seriesId}]: ${(e as Error).message}`);
    return null;
  }
}

export interface MarketRates {
  riskFreeRate: number;    // 10-year Treasury yield (DGS10)
  aaaBondYield: number;    // Moody's Aaa Corporate Bond Yield (DAAA)
}

const FALLBACK: MarketRates = { riskFreeRate: 0.045, aaaBondYield: 5.0 };

export async function getMarketRates(apiKey: string): Promise<MarketRates> {
  const [rfr, aaa] = await Promise.all([
    fetchLatest('DGS10', apiKey),
    fetchLatest('DAAA', apiKey),
  ]);

  const rates: MarketRates = {
    riskFreeRate: rfr ?? FALLBACK.riskFreeRate,
    aaaBondYield: aaa ?? FALLBACK.aaaBondYield,
  };

  logger.debug(`FRED rates — 10Y Treasury: ${(rates.riskFreeRate * 100).toFixed(2)}%, AAA: ${rates.aaaBondYield.toFixed(2)}%`);
  return rates;
}
