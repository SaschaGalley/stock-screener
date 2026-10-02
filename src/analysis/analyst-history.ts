/**
 * The analyst consensus as it stood on a past day, rebuilt from the rating
 * actions.
 *
 * Yahoo's live consensus — the mean target, the count of buys and sells — is a
 * number for today only. Its rating history is not: every action carries the
 * firm, the grade it moved to and the target it set, back to 2012 for the
 * large caps. Each firm's newest word within a year before a day is what that
 * firm was saying then; averaged across firms it is the consensus of that day,
 * as close as the history allows. It is what lets the backtest score the
 * consensus pillar, which it otherwise had to leave silent.
 *
 * What the history cannot give, it does not pretend to: estimate revisions and
 * earnings surprises are not in it.
 *
 * Pure and dependency-free so the web app can import it.
 */

import { splitFactorAfter, type AnalystAction, type Split } from './analyst-accuracy.js';

export const RATING_BUCKETS = ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'] as const;
export type RatingBucket = (typeof RATING_BUCKETS)[number];
export type RatingCounts = Record<RatingBucket, number>;

/** A firm's word older than this no longer counts towards the consensus. */
export const CONSENSUS_WINDOW_DAYS = 365;
/**
 * Fewer firms than this is not a consensus. The history thins out going back —
 * Apple's has a handful of actions before 2018 — and one stale target from a
 * thinned year would be read as the street's view.
 */
export const MIN_CONSENSUS_FIRMS = 3;
/** How far back the month-over-month rating change looks, as the live trend's two periods do. */
const MONTH_DAYS = 30;

/**
 * A broker's grade on the five-step scale the live consensus counts in. Brokers
 * name their steps differently — Outperform, Overweight, Sector Perform — and
 * the order of the tests matters: "underperform" holds "perform", "strong buy"
 * holds "buy". Null for anything unrecognised, which then counts nowhere.
 */
export function ratingBucket(grade: string | null | undefined): RatingBucket | null {
  const g = (grade ?? '').toLowerCase().replace(/[-_]/g, ' ').trim();
  if (!g) return null;
  if (/^(strong buy|conviction buy|top pick)/.test(g)) return 'strongBuy';
  if (/^strong sell/.test(g)) return 'strongSell';
  if (/\b(sell|underperform|underweight|reduce|negative)\b/.test(g)) return 'sell';
  if (/\b(buy|outperform|overweight|positive|accumulate|add)\b/.test(g)) return 'buy';
  if (/\b(hold|neutral|equal weight|perform|in line|sector weight|market weight|mixed)\b/.test(g)) return 'hold';
  return null;
}

export interface ConsensusAt {
  /** Mean of each firm's newest target, split-adjusted to today's basis; null below `MIN_CONSENSUS_FIRMS`. */
  targetMean:   number | null;
  targetMedian: number | null;
  targetHigh:   number | null;
  targetLow:    number | null;
  /** Firms with a target in the window. */
  targetFirms:  number;
  /** Each firm's newest grade, counted per step; null below `MIN_CONSENSUS_FIRMS`. */
  ratings:      RatingCounts | null;
  ratingFirms:  number;
}

const DAY_MS = 86_400_000;
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * What the firms were saying before `day` (YYYY-MM-DD): each firm's newest
 * target and newest grade from the year before it, the day itself excluded —
 * an action dated on the day may have come after the close the day is priced at.
 */
export function consensusAt(actions: readonly AnalystAction[], day: string, splits: readonly Split[] = []): ConsensusAt {
  const from = shift(day, -CONSENSUS_WINDOW_DAYS);
  const target = new Map<string, { day: string; value: number }>();
  const grade = new Map<string, { day: string; bucket: RatingBucket }>();
  for (const a of actions) {
    const d = a.gradedAt.slice(0, 10);
    if (d >= day || d < from) continue;
    if (a.priceTarget !== null && a.priceTarget > 0) {
      const seen = target.get(a.firm);
      if (!seen || d > seen.day) target.set(a.firm, { day: d, value: a.priceTarget / splitFactorAfter(splits, d) });
    }
    const bucket = ratingBucket(a.toGrade);
    if (bucket) {
      const seen = grade.get(a.firm);
      if (!seen || d > seen.day) grade.set(a.firm, { day: d, bucket });
    }
  }

  const targets = [...target.values()].map((t) => t.value).sort((a, b) => a - b);
  const enough = targets.length >= MIN_CONSENSUS_FIRMS;
  const mid = Math.floor(targets.length / 2);
  let ratings: RatingCounts | null = null;
  if (grade.size >= MIN_CONSENSUS_FIRMS) {
    ratings = Object.fromEntries(RATING_BUCKETS.map((b) => [b, 0])) as RatingCounts;
    for (const g of grade.values()) ratings[g.bucket]++;
  }
  return {
    targetMean:   enough ? targets.reduce((a, b) => a + b, 0) / targets.length : null,
    targetMedian: enough ? (targets.length % 2 ? targets[mid] : (targets[mid - 1] + targets[mid]) / 2) : null,
    targetHigh:   enough ? targets[targets.length - 1] : null,
    targetLow:    enough ? targets[0] : null,
    targetFirms:  targets.length,
    ratings,
    ratingFirms:  grade.size,
  };
}

/**
 * The change in each step's count against a month before — what the live
 * recommendation trend's two newest periods give. Null when either side has
 * too few firms to count.
 */
export function ratingDeltaAt(actions: readonly AnalystAction[], day: string, splits: readonly Split[] = []): RatingCounts | null {
  const now = consensusAt(actions, day, splits).ratings;
  const before = consensusAt(actions, shift(day, -MONTH_DAYS), splits).ratings;
  if (!now || !before) return null;
  return Object.fromEntries(RATING_BUCKETS.map((b) => [b, now[b] - before[b]])) as RatingCounts;
}
