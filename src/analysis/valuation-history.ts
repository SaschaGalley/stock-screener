/**
 * A stock's valuation over the last five years, and how to read today against it.
 *
 * Three questions the detail page could not answer from one day's numbers:
 * is a 50 % gap to fair value unusual for this stock or its normal state; is
 * the price following the earnings or running ahead of them; and is a P/E of
 * 40 expensive for a company that has never traded below 35. Each needs the
 * same thing — the stock's own past, read the way it is read today.
 *
 * The series is rebuilt in `src/backtest/history.ts`; this module only holds
 * its shape and the statistics over it. Dependency-free so the web app can
 * import it across the package boundary, like `src/cases.ts`.
 */

export const HISTORY_MULTIPLES = [
  { key: 'pe',       label: 'KGV',       hint: 'Kurs / Gewinn je Aktie (TTM)' },
  { key: 'ps',       label: 'KUV',       hint: 'Marktkapitalisierung / Umsatz (TTM)' },
  { key: 'pfcf',     label: 'P/FCF',     hint: 'Marktkapitalisierung / Free Cash Flow (TTM)' },
  { key: 'evEbitda', label: 'EV/EBITDA', hint: 'Unternehmenswert / EBITDA (TTM)' },
] as const;
export type HistoryMultiple = (typeof HISTORY_MULTIPLES)[number]['key'];

/** One month-end. Per-share figures are on today's split basis. */
export type ValuationHistoryPoint = {
  date:         string;
  price:        number;
  /** The composite's primary median as the models would have computed it that day. */
  fairValue:    number | null;
  conservative: number | null;
  /** Diluted earnings per share, trailing twelve months. */
  eps:          number | null;
} & Record<HistoryMultiple, number | null>;

/**
 * Where the series comes from, which decides what it can say.
 *
 *   sec     every month-end rebuilt from the SEC filings known that day and run
 *           through the live models — fair value included
 *   annual  the fiscal years Yahoo reports, held from a quarter after each year
 *           ends; enough for earnings and price multiples, not for a fair value
 */
export type ValuationHistorySource = 'sec' | 'annual';

export interface ValuationHistory {
  symbol:     string;
  source:     ValuationHistorySource;
  points:     ValuationHistoryPoint[];
  computedAt: string;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Share of `xs` strictly below `x`, 0–1. */
function rankOf(xs: number[], x: number): number {
  return xs.length ? xs.filter((v) => v < x).length / xs.length : 0;
}

export interface DiscountRange {
  /** Margin of safety, (fair value − price) / price: positive means below fair value. */
  p25:    number;
  median: number;
  p75:    number;
  latest: number;
  /** Share of past months with a smaller margin than today's — 0.9 is "cheaper than nine months in ten". */
  rank:   number;
  months: number;
}

/**
 * The gap between price and fair value over the window: the typical range
 * (the middle half of the months) and where today sits in it. Null below a
 * year of months, where "typically" would be a stretch.
 */
export function discountRange(points: ValuationHistoryPoint[]): DiscountRange | null {
  const m = points.flatMap((p) => (p.fairValue !== null && p.fairValue > 0 && p.price > 0
    ? [(p.fairValue - p.price) / p.price] : []));
  if (m.length < 12) return null;
  const sorted = [...m].sort((a, b) => a - b);
  const latest = m[m.length - 1];
  return {
    p25: quantile(sorted, 0.25)!, median: quantile(sorted, 0.5)!, p75: quantile(sorted, 0.75)!,
    latest, rank: rankOf(m.slice(0, -1), latest), months: m.length,
  };
}

export interface MultipleStats {
  key:      HistoryMultiple;
  latest:   number | null;
  /** Medians, not means: see `multipleStats`. */
  median3:  number | null;
  median5:  number | null;
  /** Months with a positive reading — the long median's actual span, which an annual series keeps short of five years. */
  months:   number;
  /** Share of past months with a lower multiple than today's: 0.9 is "dearer than nine months in ten". */
  rank:     number | null;
  /** The price today's fundamentals would carry at the five-year median multiple. */
  impliedPrice: number | null;
}

const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

/**
 * One multiple against the stock's own past.
 *
 * Only positive readings count: a P/E on a loss is not a cheap multiple, it is
 * no multiple. And the typical level is the median, not the mean — ServiceNow
 * traded at a P/E of 640 in 2021 on near-zero earnings, which put its
 * five-year "average" at 210 against a median of a third of that. A mean of
 * multiples is a mean of the years earnings were smallest.
 */
export function multipleStats(points: ValuationHistoryPoint[], key: HistoryMultiple): MultipleStats {
  const values = points.flatMap((p) => (p[key] !== null && p[key]! > 0 ? [p[key]!] : []));
  const last = points[points.length - 1];
  const latest = last && last[key] !== null && last[key]! > 0 ? last[key]! : null;
  const median5 = median(values.slice(-60));
  return {
    key,
    latest,
    median3: median(values.slice(-36)),
    median5,
    months: values.length,
    rank: latest !== null && values.length > 12 ? rankOf(values.slice(0, -1), latest) : null,
    impliedPrice: latest !== null && median5 !== null && last ? last.price * (median5 / latest) : null,
  };
}

/**
 * The P/E a stock has normally carried — the median of its positive P/Es over
 * the window. Earnings times this is the line a FAST-Graphs chart draws under
 * the price: where the price would sit if the market paid its usual multiple.
 */
export function normalPE(points: ValuationHistoryPoint[]): number | null {
  return multipleStats(points, 'pe').median5;
}
