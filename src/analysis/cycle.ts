/**
 * Whether the business stands at a peak of its own cycle.
 *
 * A P/E is a price over one year's earnings, and the year it is taken in may
 * be the best the company has had. At a record margin the P/E looks cheaper
 * than the business is — the classic trap of a cyclical at the top, priced on
 * earnings it will not keep — and at a trough it looks dearer. The margin
 * trend on the page compares the latest year with the four before it; this
 * reaches back through the cycle: today's margins against every year on
 * record, the median of the last ten, and the P/E as it would read with the
 * net margin at that median instead of today's (a Graham–Dodd / Shiller idea,
 * normal earnings rather than this year's).
 *
 * The years come from Finnhub's annual series, which the archive keeps from
 * every refresh and which reach back to the 1980s for the large US companies;
 * where Finnhub has fewer than five years — most listings outside the US — from
 * the four or five fiscal years Yahoo's statements carry, and the page says so.
 *
 * Whether profitability that far above its own normal goes on to revert, and
 * whether a P/E on normal earnings ranks better than the plain one, are asked
 * as backtest candidates first, from the five fiscal years the SEC payload
 * carries, under the rule every candidate passes through (`payout.ts`).
 *
 * Pure and dependency-free: the web app imports it.
 */

import type { StockFinancials } from '../types.js';

export const MARGIN_LINES = [
  { key: 'operatingMargin', label: 'Operative Marge' },
  { key: 'netMargin',       label: 'Nettomarge' },
  { key: 'fcfMargin',       label: 'FCF-Marge' },
] as const;

export type MarginKey = (typeof MARGIN_LINES)[number]['key'];

export interface MarginYear {
  year: number;
  operatingMargin: number | null;
  netMargin:       number | null;
  fcfMargin:       number | null;
}

export interface MarginHistory {
  /** Finnhub's annual series, or Yahoo's statements where Finnhub has too few years. */
  source: 'finnhub' | 'yahoo';
  years:  MarginYear[];
}

export interface MarginPlace {
  key:   MarginKey;
  label: string;
  /** Today's margin, trailing twelve months. */
  now:   number;
  /** The median of the last `window` fiscal years. */
  median: number;
  window: number;
  /** The share of the years on record that today's margin is above, and how many and since when. */
  rank:  number;
  years: number;
  since: number;
  /** The best year on record; `record` when today is at or above it. */
  best:   { year: number; value: number };
  record: boolean;
}

export interface CycleReading {
  source: MarginHistory['source'];
  lines:  MarginPlace[];
  /**
   * Read off the operating margin. `peak` and `trough`: far from its median
   * and near an end of its years. `high` and `low`: near an end of its years
   * but close to its median — a margin that has climbed or slid slowly, as
   * Microsoft's has risen over a decade, is not a cycle's top or bottom.
   */
  level:  'peak' | 'high' | 'normal' | 'low' | 'trough';
  /** The P/E with the net margin at its median instead of today's; null where either is not positive. */
  normalizedPE: number | null;
}

/** Fewer fiscal years than this say nothing about a cycle. */
export const MIN_YEARS = 5;
/** The median a margin is held against: the last ten fiscal years, about one cycle. */
const WINDOW = 10;
/**
 * A peak: this far above the median, and above this share of the years on
 * record. Newmont in 2026: 55 % against a median of 14 %, its best year.
 */
const PEAK = { ratio: 1.2, rank: 0.8 };
/** A trough: this far below the median, and below all but this share of the years. */
const TROUGH = { ratio: 0.8, rank: 0.3 };
/** Near an end of the years on record, whatever the distance to the median. */
const NEAR_END = 0.1;

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Today's margins in their own history; null with fewer than `MIN_YEARS` years of the operating margin. */
export function cycleReading(
  history: MarginHistory, now: Record<MarginKey, number | null>, pe: number | null,
): CycleReading | null {
  const years = [...history.years].sort((a, b) => a.year - b.year);
  const lines = MARGIN_LINES.flatMap(({ key, label }): MarginPlace[] => {
    const today = now[key];
    const past = years.flatMap((y) => (finite(y[key]) ? [{ year: y.year, value: y[key]! }] : []));
    if (!finite(today) || past.length < MIN_YEARS) return [];
    const recent = past.slice(-WINDOW);
    const best = past.reduce((a, b) => (b.value >= a.value ? b : a));
    return [{
      key, label, now: today,
      median: median(recent.map((p) => p.value)), window: recent.length,
      rank: past.filter((p) => p.value < today).length / past.length,
      years: past.length, since: past[0].year,
      best, record: today >= best.value,
    }];
  });
  const op = lines.find((l) => l.key === 'operatingMargin');
  if (!op) return null;

  const level = op.median > 0 && op.now >= PEAK.ratio * op.median && op.rank >= PEAK.rank ? 'peak'
    : op.median > 0 && op.now <= TROUGH.ratio * op.median && op.rank <= TROUGH.rank ? 'trough'
    : op.rank >= 1 - NEAR_END ? 'high'
    : op.rank <= NEAR_END ? 'low'
    : 'normal';
  const net = lines.find((l) => l.key === 'netMargin');
  const normalizedPE = finite(pe) && pe > 0 && net && net.now > 0 && net.median > 0 ? pe * (net.now / net.median) : null;
  return { source: history.source, lines, level, normalizedPE };
}

/** Finnhub's `/stock/metric` series as archived: per ratio, `{ period, v }` newest first. */
export interface FinnhubSeries { annual?: Record<string, { period: string; v: number }[] | undefined> }

/** The margins of Finnhub's fiscal years, each labelled with the year its period ends in. */
export function marginYearsFromFinnhub(series: FinnhubSeries | null): MarginYear[] {
  const byYear = new Map<number, MarginYear>();
  for (const { key } of MARGIN_LINES) {
    for (const p of series?.annual?.[key] ?? []) {
      const year = Number(p?.period?.slice(0, 4));
      if (!Number.isFinite(year) || !finite(p.v)) continue;
      const y = byYear.get(year) ?? { year, operatingMargin: null, netMargin: null, fcfMargin: null };
      y[key] = p.v;
      byYear.set(year, y);
    }
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** The margins of Yahoo's fiscal years, for a listing Finnhub has too little of. */
export function marginYearsFrom(h: StockFinancials['fundamentalsHistory']): MarginYear[] {
  const at = (s: { year: number; value: number }[] | undefined, year: number) => s?.find((p) => p.year === year)?.value ?? null;
  return (h.revenue ?? []).flatMap((r) => {
    if (!(r.value > 0)) return [];
    const ratio = (s: { year: number; value: number }[] | undefined) => {
      const v = at(s, r.year);
      return v === null ? null : v / r.value;
    };
    return [{ year: r.year, operatingMargin: ratio(h.operatingIncome), netMargin: ratio(h.netIncome), fcfMargin: ratio(h.freeCashFlow) }];
  });
}

// ── Backtest candidates ─────────────────────────────────────────────────────
// From the fiscal years the payload carries — five in the SEC payload, four or
// five live — so the "own past" here is shorter than the card's ten years.

/** The newest fiscal year's operating margin less the median of the years before it, in points. */
function marginVsPast(f: StockFinancials): number | null {
  const ys = marginYearsFrom(f.fundamentalsHistory).filter((y) => finite(y.operatingMargin)).sort((a, b) => a.year - b.year);
  if (ys.length < 4) return null;
  const latest = ys[ys.length - 1].operatingMargin!;
  return latest - median(ys.slice(0, -1).map((y) => y.operatingMargin!));
}

/** Earnings at the median net margin of the fiscal years on file, on the newest year's revenue, over the market value. */
function normalizedEarningsYield(f: StockFinancials): number | null {
  const ys = marginYearsFrom(f.fundamentalsHistory).filter((y) => finite(y.netMargin));
  const revenue = [...(f.fundamentalsHistory.revenue ?? [])].sort((a, b) => a.year - b.year).at(-1)?.value;
  if (ys.length < 4 || !finite(revenue) || !finite(f.marketCap) || f.marketCap <= 0) return null;
  return (median(ys.map((y) => y.netMargin!)) * revenue) / f.marketCap;
}

export const CYCLE_CANDIDATES: readonly {
  key: string; title: string; read: (f: StockFinancials) => number | null;
}[] = [
  { key: 'cycle.margin-vs-past', title: 'Operative Marge über ihrem eigenen Schnitt', read: marginVsPast },
  { key: 'cycle.normalized-earnings-yield', title: 'Gewinnrendite auf mittlerer Marge', read: normalizedEarningsYield },
];
