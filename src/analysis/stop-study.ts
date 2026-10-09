/**
 * The shape of the stop study (`backtest/stops.ts`): its exits, groups and
 * horizons, and what it reports — apart from the study, which reads price
 * files, so that the page can import them.
 *
 * Pure and dependency-free: the web app imports the types.
 */

import type { TimingGroup } from './timing.js';
import type { SplitStat } from '../backtest/top-decile.js';

/** One scored company at one month-end, with what the depot check would have read in its chart. */
export interface StopRecord {
  day:    string;
  symbol: string;
  /** Index of the entry close in the stock's price history. */
  i:      number;
  group:  TimingGroup;
  score:  number;
  /** The chart's trend that day: up 1, sideways 0, down −1. */
  trend:  -1 | 0 | 1;
  /** Twelve months' return, for the winners. */
  mom12:  number | null;
  /** The stop and the trailing width the check would have given, in split-adjusted prices. */
  stop:   number | null;
  width:  number | null;
}

/** The rule fixed before the first run. */
export const STOP_MIN_T = 2;
/** The depot check's reduce bar, by default: a score under it is weak. */
export const WEAK_SCORE = 5;
/** A position this far up over twelve months is a winner, for the trailing stop's own case. */
export const WINNER_MOM = 0.5;

export const STOP_RULES = [
  { key: 'stop',       label: 'Stop-Loss unter der Unterstützung', idea: 'Am Tag des Kaufs gesetzt, bleibt stehen.' },
  { key: 'trailing',   label: 'Trailing-Stop beim Broker',         idea: 'Fester Abstand unter dem höchsten Schlusskurs seit dem Kauf.' },
  { key: 'chandelier', label: 'Chandelier des Wächters',           idea: 'Drei Tagesschwankungen unter dem 22-Tage-Hoch, jeden Tag neu.' },
] as const;
export type StopRuleKey = (typeof STOP_RULES)[number]['key'];

export const STOP_GROUPS = [
  { key: 'all',          label: 'alle Aktien' },
  { key: 'buy',          label: 'BUY und STRONG BUY' },
  { key: 'hold',         label: 'HOLD' },
  { key: 'sell',         label: 'SELL und STRONG SELL' },
  { key: 'weak-falling', label: `Score unter ${WEAK_SCORE}, Chart fällt` },
  { key: 'winners',      label: `Gewinner: über +${WINNER_MOM * 100} % in zwölf Monaten` },
] as const;
export type StopGroupKey = (typeof STOP_GROUPS)[number]['key'];

export const STOP_HORIZONS = [3, 6] as const;

export interface StopRow {
  rule:     StopRuleKey;
  group:    StopGroupKey;
  horizon:  (typeof STOP_HORIZONS)[number];
  trades:   number;
  /** Share of the positions the rule closed early, and how many sessions in that took on average. */
  stopped:  number;
  sessions: number | null;
  /** Mean return holding and under the rule, over all positions. */
  hold:     number | null;
  ruled:    number | null;
  /** The worst twentieth's return holding and under the rule. */
  p05Hold:  number | null;
  p05Rule:  number | null;
  /** Share of positions that lost a fifth or more, holding and under the rule. */
  deepHold: number;
  deepRule: number;
  /** Under the rule minus holding, per month, and in each half of the years. */
  diff:     SplitStat;
  /** The same with the proceeds of a stop put into the index; shown, not judged. Absent without the index. */
  diffIndex?: SplitStat;
  ruledIndex?: number | null;
  first:    SplitStat;
  second:   SplitStat;
  verdict:  'bringt mehr' | 'kostet' | 'nicht belegt';
}

export interface ListRuleRow {
  rule:    'reduce' | 'buy';
  horizon: 1 | 3 | 6;
  /** The half the rule picks and the rest, in excess over the month's average stock. */
  chosen:  SplitStat;
  rest:    SplitStat;
  /** Chosen minus rest; the rule is right when it is negative for reduce and positive for buy. */
  diff:    SplitStat;
  first:   SplitStat;
  second:  SplitStat;
  verdict: 'trägt' | 'falsch herum' | 'nicht belegt';
}

export interface StopStudy {
  records: number;
  /** Positions with a stop the check could set, and with a trailing width. */
  withStop:  number;
  withWidth: number;
  rows:      StopRow[];
  lists:     ListRuleRow[];
}

