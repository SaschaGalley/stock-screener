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

/**
 * Fewer stocks than this in a sector and its distribution is not used: the
 * criterion is read against the whole market instead. Higher than the pooled
 * minimum, because a sector's twelve stocks are a sample of a few dozen, not
 * of a market.
 */
export const MIN_SECTOR_CALIBRATION_SYMBOLS = 12;

/** Where a sector's own distribution of a criterion is kept: `health.leverage@Utilities`. */
export function sectorKey(key: string, sector: string): string {
  return `${key}@${sector}`;
}

export { CALIBRATION_META };

/** Older than this, the table describes a market that has moved on. */
export const CALIBRATION_MAX_AGE_DAYS = 30;
/** This many more stocks stored than the table was made from, and it describes a smaller population. */
export const CALIBRATION_GROWTH_FACTOR = 1.25;

/**
 * Whether the committed table is due to be regenerated, and why — for the
 * admin page, since a recalibration is a commit someone has to make.
 */
export function calibrationDue(storedSymbols: number, now = Date.now()): string | null {
  const at = CALIBRATION_META.generatedAt ? Date.parse(CALIBRATION_META.generatedAt) : NaN;
  if (!Number.isFinite(at)) return 'Noch nie kalibriert';
  const days = (now - at) / 86_400_000;
  if (days > CALIBRATION_MAX_AGE_DAYS) return `Tabelle ist ${Math.floor(days)} Tage alt`;
  if (storedSymbols >= CALIBRATION_GROWTH_FACTOR * CALIBRATION_META.symbols) {
    return `${storedSymbols} Aktien gespeichert, die Tabelle kennt ${CALIBRATION_META.symbols}`;
  }
  return null;
}

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
/** A premium adjustment in place of the committed one — `usePremiumAdjustment`. */
let premiumOverride: number | null = null;

/**
 * Score against another table, `{}` for none — for tests, which pin the
 * explicit ramps and must not change meaning each time the table is regenerated.
 * No table means no premium adjustment either; `null` restores both.
 */
export function useCalibrationTable(table: CalibrationTable | null): void {
  override = table;
  premiumOverride = table === null ? null : 0;
}

/** Price with another premium adjustment; `null` restores the committed one. */
export function usePremiumAdjustment(adjustment: number | null): void {
  premiumOverride = adjustment;
}

/**
 * What the models add to the market's implied premium so that they price the
 * typical stock at its price.
 *
 * Damodaran's premium is the one at which *his* cash flows for the S&P 500
 * equal its price. Ours are harsher — growth fades within ten years, taxes
 * converge to the marginal rate, reinvestment is paid for at the firm's own
 * sales-to-capital — and at his premium the DCF valued the median stock of the
 * universe at 71 % of its price and seventy per cent of all stocks below it.
 * That is a statement about the model, not about the market. The adjustment is
 * the median premium shift at which the DCF values each universe stock at its
 * price (`pnpm run calibrate`), so that the fair values on the page say which
 * stocks are cheap for this model, not that nearly all of them are dear.
 */
export function modelPremiumAdjustment(): number {
  return premiumOverride ?? CALIBRATION_META.premiumAdjustment;
}

/**
 * Where calibrated figures go while `pnpm run calibrate` is scoring the history.
 * Null the rest of the time; scoring never reads it. A figure read within its
 * sector arrives with the sector, and goes into both distributions.
 */
type Sink = (key: string, value: number, sector?: string, direction?: 1 | -1) => void;
let collector: Sink | null = null;

/** Run `fn` with every calibrated figure it reads handed to `sink`. */
export function collectCalibrated<T>(sink: Sink, fn: () => T): T {
  collector = sink;
  try {
    return fn();
  } finally {
    collector = null;
  }
}

export interface CalibratedOptions {
  /**
   * Read the figure within its sector where the sector's distribution is deep
   * enough (`MIN_SECTOR_CALIBRATION_SYMBOLS`), and against the whole market
   * where it is not. For the balance sheet and quality: a utility carries four
   * times EBITDA in net debt because regulated returns let it, and against the
   * market every one of them scored 2 out of 10 on health for being a utility.
   */
  sector?: string | null;
  /** A table in place of the one in force — for tests. */
  table?: CalibrationTable;
}

/**
 * Points for a criterion: its percentile in the reference distribution when one
 * exists (flipped where smaller is better), else the caller's explicit ramp.
 */
export function calibrated(
  key: string, value: number | null | undefined, direction: 1 | -1,
  fallback: (v: number) => number | null, opts: CalibratedOptions = {},
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const sector = opts.sector ?? undefined;
  collector?.(key, value, sector, direction);
  const table = opts.table ?? override ?? CALIBRATION;
  const own = sector ? table[sectorKey(key, sector)] : undefined;
  const dist = own && own.symbols >= MIN_SECTOR_CALIBRATION_SYMBOLS && own.quantiles.length >= 2
    ? own : table[key];
  if (!dist || dist.symbols < MIN_CALIBRATION_SYMBOLS || dist.quantiles.length < 2) return fallback(value);
  const p = percentileIn(dist.quantiles, value);
  return direction === 1 ? p : 1 - p;
}
