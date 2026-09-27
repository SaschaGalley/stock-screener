/**
 * Where a criterion's neutral point is.
 *
 * Every criterion maps a figure onto 0–1 points, and the score treats 0.5 as
 * "says nothing either way". With hand-set ramps that was an assumption, and
 * measured over the watchlist it was wrong on most of them:
 *
 *   - the analyst rating averaged +0.43 on a −1…+1 scale, so the median stock
 *     scored 7.1 on it — sell-side ratings lean buy;
 *   - three quarters of quarters beat the consensus, so beating it was worth
 *     7.5 for the typical company;
 *   - seven stocks sat at a perfect 10 on the balance sheet and its median was
 *     8.6, while valuation's neutral point was a 15 % margin of safety.
 *
 * Two pillars that always vote bullish are not evidence; they are an offset.
 * They added half a point to every raw score and — because agreement counts
 * directions — made bullish cases look corroborated and bearish ones contested.
 *
 * So every criterion is read as a percentile of a reference distribution: the
 * figure's rank among the same criterion measured across the reference stocks.
 * That includes the ones with a natural zero. Over the S&P 500 the typical
 * member beats its peer group's margin by 4.7 points, trails its cap-weighted
 * sector ETF, and has more analysts revising up than down — zero is the neutral
 * point for one stock, not for the population. The typical stock scores 5 on
 * every criterion by construction, and a pillar that is high says the stock is
 * unusual, not that the ramp was set generously.
 *
 * The distributions are generated (`pnpm run calibrate`, see
 * `db/calibrate.ts`) from the stored history into `calibration-table.ts` and
 * committed: a scoring change is a code change, reviewed and re-scored like
 * any other. A criterion without a distribution falls back to its explicit ramp.
 */

import { CALIBRATION, CALIBRATION_META } from './calibration-table.js';

/** The reference distribution of one criterion: its 101 percentiles. */
export interface CriterionDistribution {
  /** Values at percentiles 0, 1, …, 100 of the pooled reference sample. */
  quantiles: number[];
  /** Observations pooled. */
  n: number;
  /** Stocks they came from. */
  symbols: number;
}

export type CalibrationTable = Readonly<Record<string, CriterionDistribution>>;

/** Fewer stocks than this and a distribution describes them, not a population. */
export const MIN_CALIBRATION_SYMBOLS = 10;

export { CALIBRATION_META };

/** The 101 percentiles of a sample (linear interpolation between order statistics). */
export function percentiles(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return Array.from({ length: 101 }, (_, i) => {
    if (n === 1) return sorted[0];
    const rank = (i / 100) * (n - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return lo === hi ? sorted[lo] : sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
  });
}

/**
 * The value's percentile in a sorted quantile list, as 0–1. Between two knots it
 * interpolates; on a run of equal knots — a discrete criterion, where a third of
 * the sample sits exactly at "clean" — it takes the middle of the run, so a tie
 * is ranked at its mid-point rather than at either end.
 */
export function percentileIn(quantiles: readonly number[], value: number): number {
  const n = quantiles.length;
  if (n === 0) return 0.5;
  if (value < quantiles[0]) return 0;
  if (value > quantiles[n - 1]) return 1;
  let lo = 0;
  while (lo < n && quantiles[lo] < value) lo++;
  let hi = lo;
  while (hi < n && quantiles[hi] === value) hi++;
  if (hi > lo) return ((lo + hi - 1) / 2) / (n - 1);
  // quantiles[lo - 1] < value < quantiles[lo]
  const a = quantiles[lo - 1], b = quantiles[lo];
  return (lo - 1 + (value - a) / (b - a)) / (n - 1);
}

/** A table in place of the committed one — `useCalibrationTable`. */
let override: CalibrationTable | null = null;

/**
 * Score against another table, `{}` for none — for tests, which pin the
 * explicit ramps and must not change meaning each time the table is regenerated.
 */
export function useCalibrationTable(table: CalibrationTable | null): void {
  override = table;
}

/**
 * Where calibrated figures go while `pnpm run calibrate` is scoring the history.
 * Null the rest of the time; scoring never reads it.
 */
let collector: ((key: string, value: number) => void) | null = null;

/** Run `fn` with every calibrated figure it reads handed to `sink`. */
export function collectCalibrated<T>(sink: (key: string, value: number) => void, fn: () => T): T {
  collector = sink;
  try {
    return fn();
  } finally {
    collector = null;
  }
}

/**
 * Points for a criterion: its percentile in the reference distribution when one
 * exists (flipped where smaller is better), else the caller's explicit ramp.
 */
export function calibrated(
  key: string, value: number | null | undefined, direction: 1 | -1,
  fallback: (v: number) => number | null, table?: CalibrationTable,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  collector?.(key, value);
  const dist = (table ?? override ?? CALIBRATION)[key];
  if (!dist || dist.symbols < MIN_CALIBRATION_SYMBOLS || dist.quantiles.length < 2) return fallback(value);
  const p = percentileIn(dist.quantiles, value);
  return direction === 1 ? p : 1 - p;
}
