/**
 * How the analysts' revenue consensus has moved, read from our own archive.
 *
 * Yahoo hands out the earnings-per-share consensus as it stood 7, 30, 60 and
 * 90 days ago, so the revisions pillar has its drift; for revenue it gives
 * today's figure and nothing before it. Every refresh stores the payload
 * (`snapshots`, kind `financials`), estimates included, so the archive holds
 * what Yahoo will not: the revenue consensus for each fiscal year as it stood
 * on each day we looked. When the analysts raise their price targets because a
 * product sells — Microsoft's Copilot in autumn 2026 — it is the revenue line
 * that moves first.
 *
 * Read in growth rather than in money, because the money is converted: an
 * ADR's revenue estimate arrives in the trading currency at that day's rate,
 * and a weaker kroner would read as a cut. Yahoo's growth for the current
 * fiscal year is against the last reported year, a fixed base; its growth for
 * the next year is against the current year's estimate. So within one fiscal
 * year on file both levels are known up to the same constant, the last
 * reported revenue — (1 + g₀) and (1 + g₀)(1 + g₁) — and their ratios between
 * two days are the revisions, free of any currency. Once the fiscal year rolls
 * over the base changes, and the record starts again with the new year.
 *
 * How far back it reaches is how long the archive has run; a 90-day change
 * needs 90 days of it. Nothing here can be backtested — no one published the
 * consensus as it stood — so it is shown and not scored.
 *
 * Pure and dependency-free: the web app reads the types.
 */

import type { EarningsEstimate } from '../types.js';

export interface EstimateSnapshot {
  /** When this payload was first stored (ISO). */
  at:        string;
  estimates: Pick<EarningsEstimate, 'period' | 'endDate' | 'revenueGrowth' | 'numberOfAnalysts'>[];
}

export interface YearRevision {
  period:  '0y' | '+1y';
  /** The fiscal year's end. */
  endDate: string;
  /** Expected revenue growth today: against the last reported year for `0y`, against this year's estimate for `+1y`. */
  growth:  number;
  analysts: number | null;
  /** The consensus on each day it changed, against its first value on file in this fiscal year (1 = unchanged). */
  path:    { at: string; index: number }[];
  /** The first day on file, and the change since. */
  since:       string;
  sinceChange: number;
  /** The change over the last 30 and 90 days, where the archive reaches that far. */
  d30: number | null;
  d90: number | null;
}

/**
 * A move of the consensus this large is a revision worth a word. Across the
 * watchlist in October 2026 the 30-day change was zero for half the stocks,
 * +0.13 % at the upper quartile and +0.76 % at the upper tenth.
 */
export const REVISION_MOVED = 0.005;

const DAY_MS = 86_400_000;
export const WINDOWS = [30, 90] as const;
/** Changes below this are the float rounding in Yahoo's growth fields, not a revision. */
const NOISE = 1e-6;

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The revenue consensus for this fiscal year and the next, each against its
 * own past in the archive. Null when the newest payload carries no growth for
 * the current year.
 */
export function revenueRevisions(snaps: EstimateSnapshot[], today: string): YearRevision[] | null {
  const sorted = [...snaps].sort((a, b) => a.at.localeCompare(b.at));
  const latest = [...sorted].reverse().find((s) => s.estimates.some((e) => e.period === '0y' && e.endDate && finite(e.revenueGrowth)));
  if (!latest) return null;
  const year0 = latest.estimates.find((e) => e.period === '0y')!;
  const year1 = latest.estimates.find((e) => e.period === '+1y' && e.endDate);

  // The days of this fiscal year: the current year's end is the same, so the base is.
  const levels = sorted.flatMap((s) => {
    const e0 = s.estimates.find((e) => e.period === '0y');
    if (!e0 || e0.endDate !== year0.endDate || !finite(e0.revenueGrowth) || 1 + e0.revenueGrowth <= 0) return [];
    const e1 = s.estimates.find((e) => e.period === '+1y');
    const l1 = e1 && year1 && e1.endDate === year1.endDate && finite(e1.revenueGrowth) && 1 + e1.revenueGrowth > 0
      ? (1 + e0.revenueGrowth) * (1 + e1.revenueGrowth) : null;
    return [{ at: s.at, l0: 1 + e0.revenueGrowth, l1 }];
  });

  const read = (period: '0y' | '+1y', e: Pick<EarningsEstimate, 'endDate' | 'revenueGrowth' | 'numberOfAnalysts'>, pick: (x: (typeof levels)[number]) => number | null): YearRevision | null => {
    const points: { at: string; level: number }[] = [];
    for (const x of levels) {
      const level = pick(x);
      if (level === null) continue;
      if (points.length && Math.abs(level / points[points.length - 1].level - 1) < NOISE) continue;
      points.push({ at: x.at, level });
    }
    if (points.length === 0 || !finite(e.revenueGrowth)) return null;
    const first = points[0];
    const now = points[points.length - 1].level;
    // The value as it stood on a day: the newest change at or before it, if the archive reaches back that far.
    const asOf = (day: number) => {
      if (Date.parse(first.at) > day) return null;
      let v = first.level;
      for (const p of points) if (Date.parse(p.at) <= day) v = p.level;
      return v;
    };
    const change = (days: number) => {
      const then = asOf(Date.parse(today) - days * DAY_MS);
      return then === null ? null : now / then - 1;
    };
    return {
      period, endDate: e.endDate!, growth: e.revenueGrowth, analysts: e.numberOfAnalysts ?? null,
      path: points.map((p) => ({ at: p.at, index: p.level / first.level })),
      since: first.at, sinceChange: now / first.level - 1,
      d30: change(WINDOWS[0]), d90: change(WINDOWS[1]),
    };
  };

  return [
    read('0y', year0, (x) => x.l0),
    year1 ? read('+1y', year1, (x) => x.l1) : null,
  ].filter((r): r is YearRevision => r !== null);
}
