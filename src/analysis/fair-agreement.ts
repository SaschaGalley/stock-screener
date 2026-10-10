/**
 * How far the primary models agree on a fair value — the uncertainty a fair
 * value comes with.
 *
 * InvestingPro prints "Uncertainty: high" beside its fair value; the page asks
 * "Wie einig sind sie sich?" of the same thing: the highest primary model less
 * the lowest, against their middle. With three or four models — the DCF, peer
 * multiples, Peter Lynch and the analysts' target — a range is what there is;
 * a standard deviation of four numbers would only pretend to more.
 *
 * Across the 569 stocks stored in October 2026 the spread ran from 0.40 at the
 * lower tenth to 1.73 at the upper, with the median at 0.86: about one stock in
 * six has models within half their middle of each other, two in five have them
 * further apart than the middle itself. Whether the fair value is worth more
 * where they agree is measured in the backtest's fair-value study, which splits
 * the gap's IC by these levels (`backtest/fair-value.ts`): it is not — 0.006
 * (t 0.6) where they agree, 0.004 (t 0.4) where they are far apart, in October
 * 2026. The level says how much the number hangs on the choice of model.
 *
 * Pure and dependency-free: the web app imports it.
 */

export const AGREEMENT_LEVELS = [
  { key: 'agree', answer: 'Ziemlich einig',   uncertainty: 'gering', below: 0.5 },
  { key: 'split', answer: 'Teils uneins',     uncertainty: 'mittel', below: 1 },
  { key: 'apart', answer: 'Weit auseinander', uncertainty: 'hoch',   below: Infinity },
] as const;

export type AgreementLevel = (typeof AGREEMENT_LEVELS)[number];

/** The highest model less the lowest, over their middle; null without two models and a positive middle. */
export function modelSpread(t: { min: number | null; max: number | null; median: number | null }): number | null {
  const { min, max, median } = t;
  if (min === null || max === null || median === null) return null;
  if (![min, max, median].every(Number.isFinite) || !(median > 0) || max < min) return null;
  return (max - min) / median;
}

export function agreementOf(spread: number | null): AgreementLevel | null {
  return spread === null ? null : AGREEMENT_LEVELS.find((l) => spread < l.below) ?? null;
}
