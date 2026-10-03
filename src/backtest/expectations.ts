/**
 * What the backtest leads us to expect of the live scores, written down on
 * 3 October 2026 — before a single month that will test it had closed.
 *
 * The backtest has been asked a great many questions of the same thirteen
 * years, and each one asked makes a lucky answer likelier. The live months
 * from October 2026 on are the first that no rule here has seen. They are
 * worth something only if what they are to test, and how a test is decided,
 * is fixed before they come in: otherwise any result can be read as the one
 * that was expected. So the expectations below and the rule in `judge` are
 * code, committed, and changed only by a commit that says why — and an
 * expectation added later is dated later and tests only the months after it.
 *
 * Each is read the way the backtest reads it — formation at month-ends, the
 * universe against its own average stock, windows that do not overlap — from
 * the live universe (`db/evaluate.ts`, `monthlyView`).
 *
 * The honest part is `monthsToDecide`. An effect the size the backtest found,
 * with the spread it found, needs about ten years of months to reach two
 * standard errors: the live data will not confirm a rank IC of 0.015 in any
 * time that matters. What they can do sooner is contradict one — a live
 * reading two standard errors on the wrong side — or show the backtest's
 * value already outside the live interval.
 */

/** The day the expectations below were fixed. */
export const EXPECTATIONS_REGISTERED = '2026-10-03';
/** Fewer independent windows than this and nothing is read into the live figure. */
export const MIN_WINDOWS = 6;
/**
 * A month-end counts only when the universe was scored on it, not the
 * watchlist alone: before the reference universe's first full pass on
 * 27 September 2026 the only scores were the watchlist's thirty-seven, a
 * hand-picked population the expectations are not about.
 */
export const MIN_UNIVERSE_STOCKS = 200;
/** Two standard errors either way decides. */
export const DECISIVE_T = 2;

export type ExpectationMeasure =
  /** Rank IC of the factor score over the horizon. */
  | 'ic'
  /** Inside the top tenth by factor score, the half above its median momentum pillar minus the half below. */
  | 'top-momentum-split'
  /** Stocks with a factor score of 8 or more against the average stock. */
  | 'band-8'
  /** Across all stocks, the half deeper in a timing reading's dip minus the half higher up (`backtest/timing.ts`). */
  | 'timing-split';

export interface Expectation {
  key:       string;
  /** The expectation, as the page states it. */
  claim:     string;
  measure:   ExpectationMeasure;
  /** Months. */
  horizon:   number;
  /** For `timing-split`: which reading (`analysis/timing.ts`). */
  candidate?: string;
  /** +1: the measure should be above zero; −1: below. */
  direction: 1 | -1;
  /** What the backtest measured when it was written down: run of 3 October 2026, S&P 1500, 2013–2026. */
  backtest:  { value: number; t: number; windows: number };
}

export const EXPECTATIONS: readonly Expectation[] = [
  {
    key: 'ic-1m', measure: 'ic', horizon: 1, direction: 1,
    claim: 'Der Faktor-Score ordnet die Aktien nach ihrer Rendite im Folgemonat: Rang-IC über null.',
    backtest: { value: 0.0145, t: 2.30, windows: 165 },
  },
  {
    key: 'top-momentum-6m', measure: 'top-momentum-split', horizon: 6, direction: 1,
    claim: 'Im obersten Zehntel schlägt die Hälfte mit der höheren Säule Markt & Momentum die andere über sechs Monate.',
    backtest: { value: 0.0247, t: 2.00, windows: 27 },
  },
  {
    key: 'band8-6m', measure: 'band-8', horizon: 6, direction: -1,
    claim: 'Aktien mit einem Score von 8 oder mehr liegen sechs Monate später hinter der Durchschnittsaktie.',
    backtest: { value: -0.0198, t: -1.33, windows: 27 },
  },
  {
    // Found by the timing study the same day, so the backtest cannot test it
    // again: the live months are its first test. Weaker in 2013–2019 (−0.3 %,
    // t −0.5) than in 2020–2026 (−2.7 %, t −4.1).
    key: 'near-low-6m', measure: 'timing-split', candidate: 'timing.support', horizon: 6, direction: -1,
    claim: 'Aktien nahe ihrem 6-Monats-Tief liegen sechs Monate später hinter der Hälfte, die weiter davon entfernt ist.',
    backtest: { value: -0.0146, t: -2.94, windows: 27 },
  },
];

/** A live reading of a measure: its mean over independent windows, its t, and how many windows. */
export interface LiveReading { mean: number | null; t: number | null; windows: number }

export type ExpectationStatus = 'zu früh' | 'offen' | 'bestätigt' | 'widerlegt';

export interface Judgement extends LiveReading {
  status: ExpectationStatus;
  /** The live mean's 95 % interval; null below two windows. */
  low:    number | null;
  high:   number | null;
  /** Whether the backtest's value lies inside that interval. */
  consistent: boolean | null;
  /** Months of live data an effect the backtest's size, at the backtest's spread, needs to reach two standard errors. */
  monthsToDecide: number;
}

/**
 * Windows the backtest's effect needs to reach `DECISIVE_T`, at its own
 * spread: the t of a mean grows with the square root of the windows, so
 * `(2 / t)²` times the windows it was measured on. The live universe is
 * smaller than the backtest's, so its spread is wider: a lower bound.
 */
export function monthsToDecide(e: Expectation): number {
  const windows = Math.ceil((DECISIVE_T / Math.abs(e.backtest.t)) ** 2 * e.backtest.windows);
  return windows * e.horizon;
}

/** The rule fixed with the expectations: two standard errors in the expected direction confirm, two against contradict. */
export function judge(e: Expectation, live: LiveReading): Judgement {
  const { mean, t, windows } = live;
  const se = mean !== null && t !== null && Number.isFinite(t) && t !== 0 ? Math.abs(mean / t) : null;
  const low = se !== null ? mean! - 1.96 * se : null;
  const high = se !== null ? mean! + 1.96 * se : null;
  const consistent = low !== null && high !== null ? e.backtest.value >= low && e.backtest.value <= high : null;
  let status: ExpectationStatus = 'zu früh';
  if (windows >= MIN_WINDOWS && t !== null && Number.isFinite(t)) {
    const signed = t * e.direction;
    status = signed >= DECISIVE_T ? 'bestätigt' : signed <= -DECISIVE_T ? 'widerlegt' : 'offen';
  }
  return { ...live, status, low, high, consistent, monthsToDecide: monthsToDecide(e) };
}
