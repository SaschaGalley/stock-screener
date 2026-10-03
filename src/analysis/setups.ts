/**
 * Trade setups: an entry, a stop, a target and a deadline, and whether the
 * entry is worth more than a random one.
 *
 * A stop and a target make no edge of their own. A price that wanders at
 * random from its entry reaches a target three typical moves up before a stop
 * two moves down about two times in five — the distances decide that, not the
 * stock. So a setup is worth something only if its trades do better than
 * trades with the same stop and target entered anywhere: the same months, the
 * same distances, every stock (`backtest/setups.ts`).
 *
 * Five setups, their thresholds and the first barriers were fixed before the
 * first run. Two are the idea that started this — undervalued, low in its band,
 * likely to come back — one with the channel's lower edge, one with a bounce
 * off the low; the others are what the research has something to say about:
 * a dip inside an uptrend (momentum with a short-term reversal), a new high
 * (George and Hwang 2004), and the bounce alone.
 *
 * Distances are in the stock's own typical daily move (`atr14`, from closes),
 * so a quiet utility and a quantum start-up get stops of the same meaning.
 * Dependency-free: the list and the backtest read the same definitions.
 */

import type { TimingReadings } from '../types.js';
import { BOUNCE } from './timing.js';

/** Stop and target in typical daily moves from the entry, and the sessions a trade may run. */
export interface Barriers { key: string; label: string; stopAtr: number; targetAtr: number; maxSessions: number }

/**
 * The distances. The first was fixed with the setups and is the one the rule
 * reads. The second was added after the first trial run — on 150 companies,
 * where no setup carried — because two and three moves from closes are reached
 * in about seven sessions, a trade of a week or two, while the idea was a
 * stock coming back over months. Added for the holding time, not for a result.
 */
export const BARRIER_SETS: readonly Barriers[] = [
  { key: 'short', label: 'Stop 2 ATR, Ziel 3 ATR, bis 3 Monate', stopAtr: 2, targetAtr: 3, maxSessions: 63 },
  { key: 'wide',  label: 'Stop 4 ATR, Ziel 6 ATR, bis 6 Monate', stopAtr: 4, targetAtr: 6, maxSessions: 126 },
];
/** The distances the rule reads. */
export const BARRIERS = BARRIER_SETS[0];

/** Commission and half the spread, per side. */
export const SETUP_COST_PER_SIDE = 0.001;

/** What a setup reads: the chart, and the headline fair value's gap, ln(fair / price), where there is one. */
export interface SetupInputs {
  t:       TimingReadings;
  fairGap: number | null;
}

export interface Setup {
  key:   string;
  title: string;
  /** The idea behind it, as its proponents put it. */
  idea:  string;
  fires: (x: SetupInputs) => boolean;
}

/** Undervalued: the price at least a fifth under the fair value. */
const UNDERVALUED = Math.log(1.25);
const bounced = (t: TimingReadings) =>
  t.lowAgo >= BOUNCE.minAgo && t.lowAgo <= BOUNCE.maxAgo && t.fromLow126 >= BOUNCE.minRise;

export const SETUPS: readonly Setup[] = [
  {
    key: 'undervalued-low-band', title: 'Unterbewertet, unten im Kanal',
    idea: 'Mindestens 25 % unter dem fairen Wert und am unteren Rand des 3-Monats-Kanals: Der Kurs ist unten im Band und kommt zurück.',
    fires: ({ t, fairGap }) => fairGap !== null && fairGap >= UNDERVALUED && t.channelZ !== null && t.channelZ <= -1,
  },
  {
    key: 'undervalued-bounce', title: 'Unterbewertet, vom Tief abgeprallt',
    idea: 'Mindestens 25 % unter dem fairen Wert und gerade vom 6-Monats-Tief abgeprallt: Der Boden ist gefunden.',
    fires: ({ t, fairGap }) => fairGap !== null && fairGap >= UNDERVALUED && bounced(t),
  },
  {
    key: 'dip-in-uptrend', title: 'Rücksetzer im Aufwärtstrend',
    idea: 'Über der 200-Tage-Linie, aber RSI unter 35: ein kurzer Rücksetzer in einem intakten Trend.',
    fires: ({ t }) => t.distSma200 !== null && t.distSma200 > 0 && t.rsi14 !== null && t.rsi14 < 35,
  },
  {
    key: 'new-high', title: 'Am Jahreshoch',
    idea: 'Höchstens 1 % unter dem höchsten Schlusskurs des Jahres: Was neue Hochs macht, macht weitere.',
    fires: ({ t }) => t.fromHigh252 !== null && t.fromHigh252 >= Math.log(0.99),
  },
  {
    key: 'bounce', title: 'Vom Tief abgeprallt',
    idea: 'Das 6-Monats-Tief vor 3 bis 15 Handelstagen, seitdem 5 % höher — gleich, was die Firma wert ist.',
    fires: ({ t }) => bounced(t),
  },
];

/** Stop, target and what the distance to each is worth, from a price and its typical move. */
export function tradePlan(price: number, atr: number, b: Barriers = BARRIERS): { stop: number; target: number; risk: number; reward: number } {
  return {
    stop:   price * (1 - b.stopAtr * atr),
    target: price * (1 + b.targetAtr * atr),
    risk:   b.stopAtr * atr,
    reward: b.targetAtr * atr,
  };
}

/** How a trade ended: at its target, at its stop, or when its time ran out. */
export type Exit = 'target' | 'stop' | 'time';

/**
 * A trade walked forward on daily closes from `entry` (an index into
 * `closes`): the first close at or past the target or the stop ends it, at
 * that close — a gap through the stop costs what it costs — and otherwise the
 * close `maxSessions` later. Null when the closes end before either barrier
 * or the deadline is reached.
 */
export function walkTrade(
  closes: readonly number[], entry: number, atr: number, b: Barriers = BARRIERS,
): { exit: Exit; ret: number; sessions: number } | null {
  const p0 = closes[entry];
  if (!(p0 > 0) || !(atr > 0)) return null;
  const { stop, target } = tradePlan(p0, atr, b);
  for (let k = 1; k <= b.maxSessions; k++) {
    const p = closes[entry + k];
    if (p === undefined) return null;
    if (p <= stop) return { exit: 'stop', ret: p / p0 - 1, sessions: k };
    if (p >= target) return { exit: 'target', ret: p / p0 - 1, sessions: k };
  }
  return { exit: 'time', ret: closes[entry + b.maxSessions] / p0 - 1, sessions: b.maxSessions };
}
