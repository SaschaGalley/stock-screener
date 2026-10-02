/**
 * How good the analysts' price targets for one stock have been.
 *
 * Every rating action Yahoo lists carries the firm's twelve-month target, and
 * the price archive says where the stock stood a year later. Put together,
 * each target is a prediction with a known outcome: how far the price ended
 * from it, whether it was reached at any point in the year, and whether the
 * stock at least moved the way the target implied. Per firm, that is a track
 * record; across firms, the bias of the consensus itself — the number the
 * analyst card shows every day without saying how much it has been worth.
 *
 * Targets are published per share on the day's basis; the archive's prices
 * are on today's. A target from before a split is divided by every split
 * since, or Apple's $900 target of 2012 would read as eight times its price.
 *
 * Pure and dependency-free so the web app can import the types.
 */

export interface AnalystAction {
  gradedAt:          string;
  firm:              string;
  action:            string | null;
  fromGrade:         string | null;
  toGrade:           string | null;
  priceTargetAction: string | null;
  priceTarget:       number | null;
  priorPriceTarget:  number | null;
}

export interface Bar   { day: string; close: number }
export interface Split { day: string; ratio: number }

/** One target with its outcome — or without, while its year is still running. */
export interface TargetOutcome {
  day:       string;
  firm:      string;
  /** Split-adjusted to today's basis. */
  target:    number;
  priceThen: number;
  /** What the target implied: target / price − 1. */
  implied:   number;
  /** Null while the twelve months are not over. */
  priceAfter: number | null;
  /** Price a year later against the target: −0.2 is a fifth short of it. */
  error:      number | null;
  /** Whether the price touched the target at any close within the year. */
  reached:    boolean | null;
  /** Whether the stock moved the way the target implied. */
  direction:  boolean | null;
}

export interface FirmRecord {
  firm:         string;
  /** Targets whose year is over. */
  n:            number;
  medianError:  number | null;
  reachedRate:  number | null;
  directionRate: number | null;
  last:         { day: string; target: number | null; grade: string | null };
}

export interface ConsensusPoint {
  /** Month-end. */
  day:       string;
  price:     number;
  /** Mean of each firm's newest target set within the year before. */
  target:    number | null;
  firms:     number;
  /** The consensus of twelve months earlier — the price promised for this day. */
  promised:  number | null;
}

export interface TrackRecord {
  outcomes:   TargetOutcome[];
  firms:      FirmRecord[];
  overall:    { n: number; medianError: number | null; reachedRate: number | null; directionRate: number | null; medianImplied: number | null };
  consensus:  ConsensusPoint[];
}

const YEAR_MS = 365 * 86_400_000;
/** A firm needs this many finished targets for its record to mean anything. */
export const MIN_FIRM_TARGETS = 5;
/** Below this the target is a hold, not a call on direction. */
const FLAT = 0.02;

const addDays = (day: string, ms: number) => new Date(Date.parse(`${day}T00:00:00Z`) + ms).toISOString().slice(0, 10);

/** Index of the last bar at or before `day`, or −1. */
function at(bars: Bar[], day: string): number {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].day <= day) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rate = (xs: (boolean | null)[]) => {
  const v = xs.filter((x): x is boolean => x !== null);
  return v.length ? v.filter(Boolean).length / v.length : null;
};

export function splitFactorAfter(splits: readonly Split[], day: string): number {
  return splits.reduce((f, s) => (s.day > day ? f * s.ratio : f), 1);
}

export function targetOutcomes(actions: AnalystAction[], bars: Bar[], splits: Split[]): TargetOutcome[] {
  if (bars.length === 0) return [];
  const lastDay = bars[bars.length - 1].day;
  return actions.flatMap((a): TargetOutcome[] => {
    if (a.priceTarget === null || !(a.priceTarget > 0)) return [];
    const day = a.gradedAt.slice(0, 10);
    const i0 = at(bars, day);
    if (i0 < 0) return [];
    const target = a.priceTarget / splitFactorAfter(splits, day);
    const priceThen = bars[i0].close;
    const implied = target / priceThen - 1;
    const end = addDays(day, YEAR_MS);
    if (end > lastDay) {
      return [{ day, firm: a.firm, target, priceThen, implied, priceAfter: null, error: null, reached: null, direction: null }];
    }
    const i1 = at(bars, end);
    const priceAfter = bars[i1].close;
    let hi = -Infinity, lo = Infinity;
    for (let k = i0 + 1; k <= i1; k++) { hi = Math.max(hi, bars[k].close); lo = Math.min(lo, bars[k].close); }
    const realized = priceAfter / priceThen - 1;
    return [{
      day, firm: a.firm, target, priceThen, implied, priceAfter,
      error: priceAfter / target - 1,
      reached: implied >= 0 ? hi >= target : lo <= target,
      direction: Math.abs(implied) < FLAT ? null : Math.sign(realized) === Math.sign(implied),
    }];
  });
}

/** Each firm's newest target set within the year before `day`, averaged. */
function consensusOn(outcomes: TargetOutcome[], day: string): { target: number | null; firms: number } {
  const from = addDays(day, -YEAR_MS);
  const newest = new Map<string, TargetOutcome>();
  for (const o of outcomes) {
    if (o.day > day || o.day <= from) continue;
    const seen = newest.get(o.firm);
    if (!seen || o.day > seen.day) newest.set(o.firm, o);
  }
  const targets = [...newest.values()].map((o) => o.target);
  return { target: targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : null, firms: targets.length };
}

export function trackRecord(actions: AnalystAction[], bars: Bar[], splits: Split[]): TrackRecord {
  const outcomes = targetOutcomes(actions, bars, splits);
  const done = outcomes.filter((o) => o.error !== null);

  const byFirm = new Map<string, TargetOutcome[]>();
  for (const o of outcomes) byFirm.set(o.firm, [...(byFirm.get(o.firm) ?? []), o]);
  const lastAction = new Map<string, AnalystAction>();
  for (const a of actions) {
    const seen = lastAction.get(a.firm);
    if (!seen || a.gradedAt > seen.gradedAt) lastAction.set(a.firm, a);
  }
  const firms: FirmRecord[] = [...byFirm.entries()].map(([firm, os]) => {
    const fin = os.filter((o) => o.error !== null);
    const last = lastAction.get(firm)!;
    const day = last.gradedAt.slice(0, 10);
    return {
      firm, n: fin.length,
      medianError: median(fin.map((o) => o.error!)),
      reachedRate: rate(fin.map((o) => o.reached)),
      directionRate: rate(fin.map((o) => o.direction)),
      last: {
        day,
        target: last.priceTarget !== null && last.priceTarget > 0 ? last.priceTarget / splitFactorAfter(splits, day) : null,
        grade: last.toGrade,
      },
    };
  }).sort((a, b) => b.n - a.n);

  // Month-ends from the first target on, each with the consensus then and the
  // consensus of a year before — the price that was promised for that day.
  const consensus: ConsensusPoint[] = [];
  if (outcomes.length > 0) {
    const first = outcomes.reduce((m, o) => (o.day < m ? o.day : m), outcomes[0].day);
    const monthEnds = bars.filter((b, k) => b.day >= first && (k === bars.length - 1 || bars[k + 1].day.slice(0, 7) !== b.day.slice(0, 7)));
    for (const b of monthEnds) {
      const now = consensusOn(outcomes, b.day);
      const before = consensusOn(outcomes, addDays(b.day, -YEAR_MS));
      consensus.push({ day: b.day, price: b.close, target: now.target, firms: now.firms, promised: before.target });
    }
  }

  return {
    outcomes, firms, consensus,
    overall: {
      n: done.length,
      medianError: median(done.map((o) => o.error!)),
      reachedRate: rate(done.map((o) => o.reached)),
      directionRate: rate(done.map((o) => o.direction)),
      medianImplied: median(outcomes.map((o) => o.implied)),
    },
  };
}
