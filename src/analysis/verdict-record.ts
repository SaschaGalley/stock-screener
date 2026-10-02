/**
 * How good our own verdicts have been, call by call.
 *
 * The evaluation page ranks the scores against the returns that followed, day
 * by day — the right measure for a ranking, and a number nobody acts on. This
 * is the measure the analysts' track record applies to them, turned on us:
 * every verdict as a dated statement, and how the stock did against the index
 * one, three, six and twelve months later, and for as long as the verdict held.
 *
 * A call is a change of the published verdict, read off its stored series
 * (`score.final.verdict`), the first reading included. As in the list of
 * verdict changes, a change counts once it has held through the next day's
 * reading: a score on a band's edge flips nightly, and each flip is not a call.
 *
 * Returns are total returns (adjusted closes) against the S&P 500 fund, both
 * in dollars; a listing in another currency is restated before it gets here.
 * A buy is right when the stock beat the index, a sell when it lagged it; a
 * hold makes no call on direction and is only measured.
 *
 * Pure and dependency-free so the web app can import the types.
 */

import { recommendationTone } from '../verdict.js';

/** Months after a call its outcome is read at. */
export const RECORD_HORIZONS = [1, 3, 6, 12] as const;
export type RecordHorizon = (typeof RECORD_HORIZONS)[number];

export interface VerdictPoint { at: string; verdict: string; score: number | null }
export interface Bar { day: string; close: number }

export interface Call {
  day:     string;
  verdict: string;
  /** The verdict before; null for the first reading. */
  from:    string | null;
  score:   number | null;
}

/** A stock's return over a stretch, the index's, and the difference. */
export interface Leg { stock: number; index: number | null; excess: number | null }

export interface CallOutcome extends Call {
  price:    number;
  /** The day the next call replaced it; null while it stands. */
  until:    string | null;
  /** From the call to the next one, or to the newest close while it stands. */
  held:     Leg | null;
  /** Each horizon that has passed; the rest are absent. */
  horizons: Partial<Record<RecordHorizon, Leg>>;
}

/** The newest reading of each day, oldest first. */
function daily(points: readonly VerdictPoint[]): (VerdictPoint & { day: string })[] {
  const out: (VerdictPoint & { day: string })[] = [];
  for (const p of [...points].sort((a, b) => a.at.localeCompare(b.at))) {
    const day = p.at.slice(0, 10);
    if (out.length && out[out.length - 1].day === day) out[out.length - 1] = { ...p, day };
    else out.push({ ...p, day });
  }
  return out;
}

export function verdictCalls(points: readonly VerdictPoint[]): Call[] {
  const days = daily(points);
  const calls: Call[] = [];
  let current: string | null = null;
  for (let k = 0; k < days.length; k++) {
    const p = days[k];
    if (p.verdict === current) continue;
    // A change the next day's reading takes back was a flicker, not a call.
    const next = days[k + 1];
    if (current !== null && next && next.verdict !== p.verdict) continue;
    calls.push({ day: p.day, verdict: p.verdict, from: current, score: p.score });
    current = p.verdict;
  }
  return calls;
}

/** Index of the last bar at or before `day`, or −1. */
function at(bars: readonly Bar[], day: string): number {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].day <= day) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function addMonths(day: string, months: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function leg(bars: readonly Bar[], bench: readonly Bar[] | null, from: string, to: string): Leg | null {
  const i0 = at(bars, from), i1 = at(bars, to);
  if (i0 < 0 || i1 <= i0) return null;
  const stock = bars[i1].close / bars[i0].close - 1;
  let index: number | null = null;
  if (bench) {
    const j0 = at(bench, from), j1 = at(bench, to);
    if (j0 >= 0 && j1 > j0) index = bench[j1].close / bench[j0].close - 1;
  }
  return { stock, index, excess: index === null ? null : (1 + stock) / (1 + index) - 1 };
}

export function callOutcomes(calls: readonly Call[], bars: readonly Bar[], bench: readonly Bar[] | null): CallOutcome[] {
  if (bars.length === 0) return [];
  const last = bars[bars.length - 1].day;
  return calls.flatMap((c, k): CallOutcome[] => {
    const i0 = at(bars, c.day);
    if (i0 < 0) return [];
    const until = calls[k + 1]?.day ?? null;
    const horizons: Partial<Record<RecordHorizon, Leg>> = {};
    for (const h of RECORD_HORIZONS) {
      const end = addMonths(c.day, h);
      if (end > last) continue;
      const l = leg(bars, bench, c.day, end);
      if (l) horizons[h] = l;
    }
    return [{ ...c, price: bars[i0].close, until, held: leg(bars, bench, c.day, until ?? last), horizons }];
  });
}

/** Whether a call was right: a buy that beat the index, a sell that lagged it. Null for a hold, or without the index. */
export function callHit(verdict: string, l: Leg | null | undefined): boolean | null {
  if (!l || l.excess === null) return null;
  const tone = recommendationTone(verdict);
  if (tone === 'positive') return l.excess > 0;
  if (tone === 'negative') return l.excess < 0;
  return null;
}

export interface LegStats {
  n:            number;
  meanExcess:   number | null;
  medianExcess: number | null;
  /** Share of the calls that were right; null for holds. */
  hitRate:      number | null;
}

export interface VerdictStats {
  verdict:  string;
  calls:    number;
  held:     LegStats;
  horizons: Record<RecordHorizon, LegStats>;
}

export interface VerdictRecord {
  byVerdict: VerdictStats[];
  /** Buys and sells together: how often a call on direction was right. */
  directional: Record<RecordHorizon, LegStats> & { held: LegStats };
  calls:     number;
  symbols:   number;
  from:      string | null;
}

function stats(items: { verdict: string; leg: Leg | null | undefined }[]): LegStats {
  const xs = items.flatMap((x) => (x.leg && x.leg.excess !== null ? [x.leg.excess] : [])).sort((a, b) => a - b);
  const hits = items.map((x) => callHit(x.verdict, x.leg)).filter((h): h is boolean => h !== null);
  const m = Math.floor(xs.length / 2);
  return {
    n: xs.length,
    meanExcess: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    medianExcess: xs.length ? (xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2) : null,
    hitRate: hits.length ? hits.filter(Boolean).length / hits.length : null,
  };
}

/** Every stock's calls together, by verdict, in the order of the scale. */
export function verdictRecord(bySymbol: ReadonlyMap<string, readonly CallOutcome[]>, order: readonly string[]): VerdictRecord {
  const all = [...bySymbol.values()].flat();
  const horizonStats = (calls: readonly CallOutcome[]) => Object.fromEntries(RECORD_HORIZONS.map((h) => [
    h, stats(calls.map((c) => ({ verdict: c.verdict, leg: c.horizons[h] }))),
  ])) as Record<RecordHorizon, LegStats>;
  const verdicts = [...new Set(all.map((c) => c.verdict))]
    .sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
  const directional = all.filter((c) => recommendationTone(c.verdict) !== 'neutral');
  return {
    byVerdict: verdicts.map((v) => {
      const calls = all.filter((c) => c.verdict === v);
      return {
        verdict: v, calls: calls.length,
        held: stats(calls.map((c) => ({ verdict: v, leg: c.held }))),
        horizons: horizonStats(calls),
      };
    }),
    directional: { ...horizonStats(directional), held: stats(directional.map((c) => ({ verdict: c.verdict, leg: c.held }))) },
    calls: all.length,
    symbols: [...bySymbol.values()].filter((cs) => cs.length > 0).length,
    from: all.reduce<string | null>((m, c) => (m === null || c.day < m ? c.day : m), null),
  };
}
