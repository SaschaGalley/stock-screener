/**
 * Does it matter where on its chart a stock is bought?
 *
 * The timing candidates (`analysis/timing.ts`) are measured twice. Across the
 * whole cross-section each is an ordinary candidate signal, with its IC beside
 * the score's (`candidate.timing.*` in the evaluation). That answers whether a
 * stock deeper in its dip does better than one riding high — but the question
 * the readings are asked to answer is narrower: given the verdict, is it worth
 * waiting for the chart? A BUY bought at the lower edge of its channel against
 * a BUY bought at the upper one; a SELL that has already fallen against a SELL
 * that has not.
 *
 * So each month the stocks of each verdict group are split at the group's own
 * median of a reading, and the half deeper down is set against the half
 * higher up, in excess returns over the month's average stock, as the bands
 * read them (`monthlyExcess`). Seven readings, four groups and three horizons
 * are eighty-four chances for noise, so the rule for what counts was fixed
 * with the candidates, before the first run: |t| of at least 2 over all
 * months, and the same sign in both halves of the years.
 */

import { TIMING_CANDIDATES, TIMING_GROUPS, type TimingGroup } from '../analysis/timing.js';
import type { Close } from '../analysis/evaluate.js';
import { median } from './cross-section.js';
import { HALF, monthlyExcess, splitStat, type SplitStat } from './top-decile.js';

export { TIMING_GROUPS, timingGroup, type TimingGroup } from '../analysis/timing.js';

export const TIMING_HORIZONS = [1, 3, 6] as const;

/** One scored company at one month-end: its verdict's group and the readings, NaN where there was none. */
export interface TimingRecord {
  day:      string;
  symbol:   string;
  group:    TimingGroup;
  readings: Float64Array;
}

/** A record's readings in `TIMING_CANDIDATES` order, turned the way the candidates turn them. */
export function timingArray(read: (c: (typeof TIMING_CANDIDATES)[number]) => number | null): Float64Array {
  return Float64Array.from(TIMING_CANDIDATES, (c) => {
    const v = read(c);
    return v !== null && Number.isFinite(v) ? v : NaN;
  });
}

/** Fewer stocks than this on either side of a month's split and the month says nothing about it. */
const MIN_SIDE = 3;
/** The rule, fixed with the candidates: this |t| over all months, and the same sign in both halves. */
export const TIMING_MIN_T = 2;

export interface TimingSplit {
  candidate: string;
  group:     (typeof TIMING_GROUPS)[number]['key'];
  horizon:   number;
  /** The half deeper down — above the group's median of the turned reading — and the half higher up. */
  deep:      SplitStat;
  high:      SplitStat;
  /** Deep minus high: what waiting for the dip earned. */
  diff:      SplitStat;
  first:     SplitStat;
  second:    SplitStat;
  /** Whether the difference meets the rule. */
  holds:     boolean;
}

export interface TimingStudy {
  candidates: { key: string; title: string; claim: string }[];
  splits:     TimingSplit[];
  /** Company-months with readings, and the share of them in each group. */
  records:    number;
  groupShare: Record<TimingGroup, number>;
}

export function timingStudy(
  records: readonly TimingRecord[], prices: ReadonlyMap<string, Close[]>, monthEnds: readonly string[],
): TimingStudy {
  const byDay = new Map<string, TimingRecord[]>();
  for (const r of records) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
  const days = [...byDay.keys()].sort();

  const splits: TimingSplit[] = [];
  for (const h of TIMING_HORIZONS) {
    const excess = monthlyExcess(byDay, prices, monthEnds, h);
    for (const [i, c] of TIMING_CANDIDATES.entries()) {
      for (const g of TIMING_GROUPS) {
        const deeps: number[] = [], highs: number[] = [], diffs: number[] = [], first: number[] = [], second: number[] = [];
        // Every h-th month only: overlapping windows are not independent.
        days.forEach((day, k) => {
          if (k % h !== 0) return;
          const inside = byDay.get(day)!.filter((r) =>
            (g.key === 'all' || r.group === g.key) && excess.has(r) && Number.isFinite(r.readings[i]));
          const cut = median(inside.map((r) => r.readings[i]));
          if (cut === null) return;
          const deep = inside.filter((r) => r.readings[i] > cut).map((r) => excess.get(r)!);
          const high = inside.filter((r) => r.readings[i] <= cut).map((r) => excess.get(r)!);
          if (deep.length < MIN_SIDE || high.length < MIN_SIDE) return;
          const m = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
          deeps.push(m(deep));
          highs.push(m(high));
          diffs.push(m(deep) - m(high));
          (day < HALF ? first : second).push(m(deep) - m(high));
        });
        const diff = splitStat(diffs), a = splitStat(first), b = splitStat(second);
        const sign = Math.sign(diff.mean ?? 0);
        splits.push({
          candidate: c.key, group: g.key, horizon: h,
          deep: splitStat(deeps), high: splitStat(highs), diff, first: a, second: b,
          holds: diff.t !== null && Math.abs(diff.t) >= TIMING_MIN_T && sign !== 0
            && Math.sign(a.mean ?? 0) === sign && Math.sign(b.mean ?? 0) === sign,
        });
      }
    }
  }

  const counts: Record<TimingGroup, number> = { buy: 0, hold: 0, sell: 0 };
  for (const r of records) counts[r.group]++;
  const n = records.length;
  return {
    candidates: TIMING_CANDIDATES.map(({ key, title, claim }) => ({ key, title, claim })),
    splits,
    records: n,
    groupShare: { buy: n ? counts.buy / n : 0, hold: n ? counts.hold / n : 0, sell: n ? counts.sell / n : 0 },
  };
}
