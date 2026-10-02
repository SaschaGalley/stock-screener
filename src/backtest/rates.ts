/**
 * The rates the models would have discounted with on a past day.
 *
 * Month-end values from FRED — the ten-year Treasury, Moody's AAA and the ICE
 * BofA spreads per rating — and Damodaran's implied premium for the month. A
 * series FRED no longer serves that far back (the ICE spreads are licensed for
 * a few recent years only) falls back to the constants the live code falls
 * back to, which is what the models would have used without a reading.
 */

import { getImpliedERPSeries } from '../data/damodaran.js';
import { FALLBACK_RATES, FRED_SERIES, MarketRates } from '../data/fred.js';
import { RATING_BUCKETS } from '../data/ratings.js';
import { logger } from '../utils/logger.js';

const FRED = 'https://api.stlouisfed.org/fred/series/observations';

/** Month (YYYY-MM) → end-of-month value, in percent as FRED publishes it. */
async function monthlySeries(seriesId: string, from: string, apiKey: string): Promise<Map<string, number>> {
  const params = new URLSearchParams({
    series_id: seriesId, api_key: apiKey, file_type: 'json',
    observation_start: from, frequency: 'm', aggregation_method: 'eop',
  });
  const out = new Map<string, number>();
  try {
    const res = await fetch(`${FRED}?${params}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { observations?: { date: string; value: string }[] };
    for (const o of data.observations ?? []) {
      const v = Number(o.value);
      if (o.value !== '.' && Number.isFinite(v)) out.set(o.date.slice(0, 7), v);
    }
  } catch (e) {
    logger.warn(`FRED ${seriesId} history: ${(e as Error).message}`);
  }
  return out;
}

/** The newest value at or before `month`. */
function asOfMonth(series: Map<string, number>, month: string): number | undefined {
  let best: string | null = null;
  for (const k of series.keys()) if (k <= month && (best === null || k > best)) best = k;
  return best === null ? undefined : series.get(best);
}

/** A function from a day to the rates in force on it. */
export async function rateHistory(from: string, fredApiKey: string | null | undefined): Promise<(asOf: string) => MarketRates> {
  const empty = new Map<string, number>();
  const [rf, aaa, ...spreads] = fredApiKey
    ? await Promise.all([
      monthlySeries(FRED_SERIES.tenYear, from, fredApiKey),
      monthlySeries(FRED_SERIES.aaa, from, fredApiKey),
      ...RATING_BUCKETS.map((b) => monthlySeries(b.fredSeries, from, fredApiKey)),
    ])
    : [empty, empty, ...RATING_BUCKETS.map(() => empty)];
  const erp = new Map<string, number>();
  try {
    for (const x of await getImpliedERPSeries()) if (x.asOf) erp.set(x.asOf, x.premium);
  } catch (e) {
    logger.warn(`Damodaran premium history: ${(e as Error).message}`);
  }

  return (asOf: string) => {
    const month = asOf.slice(0, 7);
    const pct = (s: Map<string, number>) => { const v = asOfMonth(s, month); return v === undefined ? undefined : v / 100; };
    const creditSpreads = { ...FALLBACK_RATES.creditSpreads };
    RATING_BUCKETS.forEach((b, k) => {
      const v = pct(spreads[k]);
      if (v !== undefined) creditSpreads[b.rating] = v;
    });
    return {
      riskFreeRate:      pct(rf) ?? FALLBACK_RATES.riskFreeRate,
      aaaBondYield:      pct(aaa) ?? FALLBACK_RATES.aaaBondYield,
      equityRiskPremium: asOfMonth(erp, month) ?? FALLBACK_RATES.equityRiskPremium,
      creditSpreads,
      localRiskFreeRates: {},
    };
  };
}
