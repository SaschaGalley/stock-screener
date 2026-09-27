/**
 * Trailing-twelve-month arithmetic on statement series.
 *
 * Yahoo's market-side block (`financialData`) hands out ready-made trailing
 * figures, and three of them turned out not to mean what their names say:
 * `freeCashflow` is S&P's *levered* free cash flow (Microsoft 16.5 bn against
 * 67.0 bn of operating cash flow less capex), and `revenueGrowth` and
 * `earningsGrowth` compare the latest *quarter* with the same quarter a year
 * earlier (Apple 16.4 % in a year that grew 6.4 %; Alphabet's earnings "grew"
 * 294 % on a revaluation gain). So the trailing figures are rebuilt here from the
 * quarterly statements, where the definitions are the ones the models assume.
 *
 * Shared by the data layer, which fills the payload, and the models, which
 * rebuild the same figures for payloads stored before the data layer did.
 * Dependency-free, like `run-rate.ts`.
 */

/** One statement figure at the end of a fiscal quarter. */
export interface QuarterPoint { endDate: string; value: number }

/** One statement figure for a fiscal year. */
export interface YearPoint { year: number; value: number }

const DAY_MS = 86_400_000;

/**
 * Days between two consecutive fiscal quarter ends. A 52/53-week calendar moves
 * a quarter end by up to a week, so the window is wide; a dropped quarter
 * doubles the gap and falls outside it.
 */
const QUARTER_GAP_DAYS = { min: 75, max: 105 } as const;

function daysBetween(from: string, to: string): number | null {
  const d = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  return Number.isFinite(d) ? d : null;
}

/**
 * The newest `n` quarters, oldest first — but only when they follow each other
 * without a gap. Yahoo drops a quarter now and then, and a sum across a hole is
 * five quarters' worth of time passed off as four.
 */
export function consecutiveQuarters(series: readonly QuarterPoint[], n: number): QuarterPoint[] | null {
  if (series.length < n) return null;
  const tail = series.slice(-n);
  for (let i = 1; i < tail.length; i++) {
    const gap = daysBetween(tail[i - 1].endDate, tail[i].endDate);
    if (gap === null || gap < QUARTER_GAP_DAYS.min || gap > QUARTER_GAP_DAYS.max) return null;
  }
  return tail;
}

function sum(points: readonly { value: number }[]): number {
  return points.reduce((s, p) => s + p.value, 0);
}

/** The last four consecutive quarters summed: a trailing-twelve-month flow. */
export function trailingSum(series: readonly QuarterPoint[]): number | null {
  const q = consecutiveQuarters(series, 4);
  return q ? sum(q) : null;
}

/**
 * The trailing twelve months against the twelve before them. Null on a base
 * that is not positive: growth off a loss is an artefact, not a rate.
 */
export function trailingGrowth(series: readonly QuarterPoint[]): number | null {
  const q = consecutiveQuarters(series, 8);
  if (!q) return null;
  const prior = sum(q.slice(0, 4));
  return prior > 0 ? sum(q.slice(4)) / prior - 1 : null;
}

/**
 * Growth between the two newest fiscal years; null on a base that is not
 * positive. Growth off a loss or a zero is not a percentage, it is an artefact:
 * Yahoo's own `earningsGrowth` for FACC was 123.2 (+12,320 %) for exactly this
 * reason, and the synthesis quoted it as evidence of momentum.
 */
export function annualGrowth(series: readonly YearPoint[] | undefined): number | null {
  if (!series || series.length < 2) return null;
  const prev = series[series.length - 2].value;
  const curr = series[series.length - 1].value;
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) return null;
  return curr / prev - 1;
}

/** Newest value of a fiscal series, or null when there is none. */
export function latestValue(series: readonly { value: number }[] | undefined): number | null {
  const v = series && series.length > 0 ? series[series.length - 1].value : null;
  return v !== null && Number.isFinite(v) ? v : null;
}
