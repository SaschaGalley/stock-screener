/**
 * The fiscal years behind a company and the two the analysts expect ahead,
 * on one axis.
 *
 * The page showed the reported years in one chart and the consensus as growth
 * rates in another, so "is the expected growth more of the same or a break
 * from it" took two charts and arithmetic. Here the two meet: the reported
 * revenue and EPS, then the consensus for the current and next fiscal year,
 * each estimate with the spread of the analysts behind it.
 *
 * Dependency-free so the web app can import it, like `src/analysis/trends.ts`.
 */

import type { YearValue } from './trends.js';

export interface ForecastYear {
  year:      number;
  estimate:  boolean;
  revenue:   number | null;
  eps:       number | null;
  /** The lowest and highest analyst EPS estimate; null on reported years. */
  epsLow:    number | null;
  epsHigh:   number | null;
  analysts:  number | null;
}

/** The structural slices of the payload this reads. */
export interface ForecastInput {
  history:   { revenue: YearValue[]; eps: YearValue[] };
  estimates: {
    period: string; endDate: string | null;
    epsEstimate: number | null; epsLow: number | null; epsHigh: number | null;
    revenueEstimate: number | null; numberOfAnalysts: number | null;
  }[];
}

/** Yahoo's annual estimate periods: the fiscal year in progress, and the one after. */
const ANNUAL_PERIODS = ['0y', '+1y'];

export function pastAndForecast({ history, estimates }: ForecastInput): ForecastYear[] {
  const rev = new Map(history.revenue.map((p) => [p.year, p.value]));
  const eps = new Map(history.eps.map((p) => [p.year, p.value]));
  const years = [...new Set([...rev.keys(), ...eps.keys()])].sort((a, b) => a - b);
  const out: ForecastYear[] = years.map((year) => ({
    year, estimate: false, revenue: rev.get(year) ?? null, eps: eps.get(year) ?? null,
    epsLow: null, epsHigh: null, analysts: null,
  }));

  const last = years[years.length - 1] ?? -Infinity;
  for (const e of estimates) {
    if (!ANNUAL_PERIODS.includes(e.period) || !e.endDate) continue;
    const year = Number(e.endDate.slice(0, 4));
    // A fiscal year already reported is not a forecast, whatever the period label says.
    if (!Number.isFinite(year) || year <= last) continue;
    out.push({
      year, estimate: true, revenue: e.revenueEstimate, eps: e.epsEstimate,
      epsLow: e.epsLow, epsHigh: e.epsHigh, analysts: e.numberOfAnalysts,
    });
  }
  return out.sort((a, b) => a.year - b.year);
}

export interface GrowthPair {
  /** Compound annual growth over the reported years. */
  past:      number | null;
  pastYears: number;
  /** From the last reported year to the furthest estimate. */
  ahead:     number | null;
  aheadYears: number;
}

const cagr = (from: number | null, to: number | null, years: number) =>
  from !== null && to !== null && from > 0 && to > 0 && years > 0 ? (to / from) ** (1 / years) - 1 : null;

/** Growth behind and growth expected, for one line of the chart. */
export function growthPair(rows: ForecastYear[], pick: (r: ForecastYear) => number | null): GrowthPair {
  const actual = rows.filter((r) => !r.estimate && pick(r) !== null);
  const est = rows.filter((r) => r.estimate && pick(r) !== null);
  const first = actual[0], lastActual = actual[actual.length - 1], lastEst = est[est.length - 1];
  const pastYears = first && lastActual ? lastActual.year - first.year : 0;
  const aheadYears = lastActual && lastEst ? lastEst.year - lastActual.year : 0;
  return {
    past: first && lastActual ? cagr(pick(first), pick(lastActual), pastYears) : null, pastYears,
    ahead: lastActual && lastEst ? cagr(pick(lastActual), pick(lastEst), aheadYears) : null, aheadYears,
  };
}
