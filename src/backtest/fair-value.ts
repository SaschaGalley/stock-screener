/**
 * The fair value put to the test: is a stock below it a better holding than
 * one above it, does the price move towards it, and does its range say where
 * the price will be?
 *
 * The score reads the valuation through its criteria — the DCF's share of
 * scenarios above the price, multiples against peers, what the price implies —
 * and the backtest measures those. The page's headline is something else: the
 * composite fair value, the weighted median of the primary models (the DCF,
 * peer multiples, Peter Lynch and the analysts' target), with the range of
 * those models around it, and the conservative lens beside it. That number has
 * not been tested. Four questions, asked of every company-month the backtest
 * scores (with `--studies`):
 *
 *   1. Rank: does the margin of safety order the returns that followed — the
 *      rank IC of the log gap ln(fair / price), and its tenths.
 *   2. Convergence: how much of the gap closes. Each month the excess returns
 *      are regressed on the gap across the stocks; the slope is the share of
 *      the log gap the stock gained on the average stock over the horizon. A
 *      fair value the price ignores has a slope of zero; one the price obeys,
 *      a slope towards one.
 *   3. Position: where the price stood in the primary models' range — below
 *      the lowest, in its lower or upper quarter, in its middle half, above
 *      the highest — and what each position earned.
 *   4. Range: how often the price stood inside the range when it was drawn,
 *      and how often it stood inside that same range a horizon later. If the
 *      price moved towards value, the second share would be the larger.
 *
 * The fair value here is the backtest's: no consensus estimates, so the DCF
 * starts from trailing growth, and the rebuilt analyst target stands in for
 * today's. The live comparison (`fidelity.ts`) puts the DCF criterion's
 * agreement with the app's at a rank correlation of 0.66.
 */

import {
  bucketReturns, evaluate, meanTest, type BucketReturn, type Close, type Evaluation, type SignalPoint,
} from '../analysis/evaluate.js';
import type { ComputedMetrics } from '../analysis/computeMetrics.js';

/** The values kept per company-month, in this order. */
export const FAIR_FIELDS = [
  'primary', 'primaryMin', 'primaryMax', 'primaryP25', 'primaryP75', 'conservative', 'dcf', 'dcfBear', 'dcfBull',
] as const;
type FairField = (typeof FAIR_FIELDS)[number];
const F = Object.fromEntries(FAIR_FIELDS.map((k, i) => [k, i])) as Record<FairField, number>;

/** The lenses whose gap is tested as a signal. */
export const FAIR_LENSES: readonly { key: string; field: FairField; label: string }[] = [
  { key: 'fair.primary',      field: 'primary',      label: 'Fairer Wert (primär, die Schlagzeile)' },
  { key: 'fair.conservative', field: 'conservative', label: 'Konservative Linse' },
  { key: 'fair.dcf',          field: 'dcf',          label: 'DCF (Basisfall)' },
];

/** Where the price stood in the primary range, low to high. */
export const FAIR_POSITIONS = ['unter der Spanne', 'unteres Viertel', 'mittlere Hälfte', 'oberes Viertel', 'über der Spanne'] as const;

export const FAIR_HORIZONS = [1, 3, 6, 12];
const WINSOR = 0.025;

/** One company at one month-end: its price and the values in `FAIR_FIELDS` order, NaN where none. */
export interface FairRecord {
  day:    string;
  symbol: string;
  price:  number;
  values: Float64Array;
}

export function fairRecord(day: string, symbol: string, price: number, m: Pick<ComputedMetrics, 'composite' | 'dcf'>): FairRecord {
  const p = m.composite.primary, c = m.composite.conservative, d = m.dcf;
  const read: Record<FairField, number | null | undefined> = {
    primary: p.median, primaryMin: p.min, primaryMax: p.max, primaryP25: p.p25, primaryP75: p.p75,
    conservative: c.median, dcf: d.fairValue, dcfBear: d.fairValueBear, dcfBull: d.fairValueBull,
  };
  return {
    day, symbol, price,
    values: Float64Array.from(FAIR_FIELDS, (k) => {
      const v = read[k];
      return v !== null && v !== undefined && Number.isFinite(v) && v > 0 ? v : NaN;
    }),
  };
}

export interface Convergence { lens: string; horizon: number; slope: number | null; t: number | null; months: number }

export interface RangeHold {
  range:   'primary' | 'primary-middle' | 'dcf';
  label:   string;
  horizon: number;
  /** Company-months with the range and both prices. */
  n:       number;
  /** Share with the price inside the range when it was drawn, and inside the same range a horizon later. */
  then:    number;
  later:   number;
}

export interface FairValueStudy {
  /** Share of the company-months each lens had a value for. */
  coverage: Record<string, number>;
  /** The median gap at formation, ln(fair / price): what the lens says of the typical stock. */
  medianGap: Record<string, number | null>;
  /** Rank IC of each lens's gap, as the evaluation measures every signal. */
  ics: Evaluation['ics'];
  /** The primary gap's tenths against the month's average stock. */
  deciles: BucketReturn[];
  convergence: Convergence[];
  /** What each position in the primary range earned against the month's average stock. */
  positions: BucketReturn[];
  /** How often each position held a stock — of the company-months with a range. */
  positionShare: Record<string, number>;
  ranges: RangeHold[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Index of the last close at or before `day`, or −1. */
function at(closes: readonly Close[], day: string): number {
  let lo = 0, hi = closes.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closes[mid].date <= day) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function clip(xs: number[]): (v: number) => number {
  const s = [...xs].sort((a, b) => a - b);
  const lo = s[Math.floor(WINSOR * (s.length - 1))], hi = s[Math.ceil((1 - WINSOR) * (s.length - 1))];
  return (v) => Math.min(hi, Math.max(lo, v));
}

export function positionOf(price: number, v: Float64Array): (typeof FAIR_POSITIONS)[number] | null {
  const min = v[F.primaryMin], max = v[F.primaryMax], p25 = v[F.primaryP25], p75 = v[F.primaryP75];
  if (![min, max, p25, p75].every(Number.isFinite) || max <= min) return null;
  if (price < min) return 'unter der Spanne';
  if (price < p25) return 'unteres Viertel';
  if (price <= p75) return 'mittlere Hälfte';
  if (price <= max) return 'oberes Viertel';
  return 'über der Spanne';
}

export function fairValueStudy(input: {
  records:  readonly FairRecord[];
  /** Total-return closes: what a holder earned. */
  prices:   Map<string, Close[]>;
  /** Split-adjusted closes without dividends: where the quoted price went, for the range. */
  closes:   ReadonlyMap<string, Close[]>;
  /** The month-ends with their benchmark closes. */
  calendar: Close[];
  sectors:  Map<string, string>;
}): FairValueStudy {
  const { records, prices, closes, calendar, sectors } = input;
  const n = records.length || 1;

  // The gaps as signals, dated the day before their month-end as the score is.
  const signals = new Map<string, Map<string, SignalPoint[]>>(FAIR_LENSES.map((l) => [l.key, new Map()]));
  const position = new Map<string, SignalPoint[]>();
  const push = (m: Map<string, SignalPoint[]>, symbol: string, p: SignalPoint) => {
    const list = m.get(symbol);
    if (list) list.push(p); else m.set(symbol, [p]);
  };
  const coverage: Record<string, number> = {};
  const gaps: Record<string, number[]> = {};
  for (const l of FAIR_LENSES) { coverage[l.key] = 0; gaps[l.key] = []; }
  const positionCount = new Map<string, number>();
  let ranged = 0;
  for (const r of records) {
    const formed = new Date(Date.parse(`${r.day}T12:00:00Z`) - 86_400_000);
    for (const l of FAIR_LENSES) {
      const v = r.values[F[l.field]];
      if (!Number.isFinite(v) || !(r.price > 0)) continue;
      const gap = Math.log(v / r.price);
      coverage[l.key]++;
      gaps[l.key].push(gap);
      push(signals.get(l.key)!, r.symbol, { at: formed, value: gap });
    }
    const pos = positionOf(r.price, r.values);
    if (pos) {
      ranged++;
      positionCount.set(pos, (positionCount.get(pos) ?? 0) + 1);
      push(position, r.symbol, { at: formed, value: null, text: pos });
    }
  }
  for (const l of FAIR_LENSES) coverage[l.key] /= n;

  const common = { prices, benchmark: calendar, horizons: FAIR_HORIZONS };
  const ics = evaluate({ ...common, signals, sectors }).ics;
  const deciles = bucketReturns({ ...common, points: signals.get('fair.primary')!, bucket: 'decile' });
  const positions = bucketReturns({ ...common, points: position, bucket: (p) => p.text ?? null });

  // Convergence and the range, from the records themselves.
  const byDay = new Map<string, FairRecord[]>();
  for (const r of records) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
  const days = calendar.map((c) => c.date);
  const convergence: Convergence[] = [];
  const ranges: RangeHold[] = [];
  const RANGES = [
    { range: 'primary' as const, label: 'Spanne der primären Modelle (Min–Max)', lo: F.primaryMin, hi: F.primaryMax },
    { range: 'primary-middle' as const, label: 'Ihre mittlere Hälfte (p25–p75)', lo: F.primaryP25, hi: F.primaryP75 },
    { range: 'dcf' as const, label: 'DCF Bär bis Bulle (p10–p90)', lo: F.dcfBear, hi: F.dcfBull },
  ];
  for (const h of FAIR_HORIZONS) {
    const slopes = new Map<string, number[]>(FAIR_LENSES.map((l) => [l.key, []]));
    const hold = RANGES.map(() => ({ n: 0, then: 0, later: 0 }));
    days.forEach((day, i) => {
      if (i + h >= days.length) return;
      const exit = days[i + h];
      const month = byDay.get(day);
      if (!month) return;
      // Returns over the window, each stock's against the month's average, clipped.
      const rows = month.flatMap((r) => {
        const px = prices.get(r.symbol);
        if (!px) return [];
        const a = at(px, day), b = at(px, exit);
        return a >= 0 && b > a ? [{ r, ret: px[b].close / px[a].close - 1 }] : [];
      });
      if (rows.length < 30) return;
      const cr = clip(rows.map((x) => x.ret));
      const avg = rows.reduce((s, x) => s + cr(x.ret), 0) / rows.length;
      if (i % h === 0) {
        for (const l of FAIR_LENSES) {
          const pts = rows.flatMap((x) => {
            const v = x.r.values[F[l.field]];
            return Number.isFinite(v) && x.r.price > 0 ? [{ g: Math.log(v / x.r.price), y: cr(x.ret) - avg }] : [];
          });
          if (pts.length < 30) continue;
          const cg = clip(pts.map((p) => p.g));
          const gs = pts.map((p) => cg(p.g)), mg = gs.reduce((a, b) => a + b, 0) / gs.length;
          const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
          let cov = 0, vg = 0;
          pts.forEach((p, k) => { cov += (gs[k] - mg) * (p.y - my); vg += (gs[k] - mg) ** 2; });
          if (vg > 0) slopes.get(l.key)!.push(cov / vg);
        }
      }
      // Every month for the range: where the quoted price went, not what a holder earned.
      for (const r of month) {
        const c = closes.get(r.symbol);
        if (!c) continue;
        const a = at(c, day), b = at(c, exit);
        if (a < 0 || b <= a || !(c[a].close > 0)) continue;
        const later = r.price * (c[b].close / c[a].close);
        RANGES.forEach((g, k) => {
          const lo = r.values[g.lo], hi = r.values[g.hi];
          if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
          hold[k].n++;
          if (r.price >= lo && r.price <= hi) hold[k].then++;
          if (later >= lo && later <= hi) hold[k].later++;
        });
      }
    });
    for (const l of FAIR_LENSES) {
      const xs = slopes.get(l.key)!;
      convergence.push({
        lens: l.key, horizon: h, months: xs.length,
        slope: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, t: meanTest(xs).t,
      });
    }
    RANGES.forEach((g, k) => {
      if (hold[k].n) ranges.push({ range: g.range, label: g.label, horizon: h, n: hold[k].n, then: hold[k].then / hold[k].n, later: hold[k].later / hold[k].n });
    });
  }

  return {
    coverage,
    medianGap: Object.fromEntries(FAIR_LENSES.map((l) => [l.key, median(gaps[l.key])])),
    ics, deciles, convergence, positions,
    positionShare: Object.fromEntries(FAIR_POSITIONS.map((p) => [p, ranged ? (positionCount.get(p) ?? 0) / ranged : 0])),
    ranges,
  };
}
