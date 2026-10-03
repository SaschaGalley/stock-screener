/**
 * Do the setups beat a random entry with the same stop and target?
 *
 * At every month-end every scored stock is a trade: entered at the close,
 * stopped two typical moves down, taken three up, closed after three months
 * otherwise (`analysis/setups.ts`), and charged a commission each way. Those
 * are the random entries — the same distances, the same months, nothing
 * chosen. A setup's trades are the ones it fired on, and what it is worth is
 * how much more they earned than the month's random ones.
 *
 * Trades run up to three months — six under the wider distances — so
 * neighbouring months overlap: the t is read on every third (sixth) month
 * only, as the evaluation counts its windows. The rule was
 * fixed with the setups: a setup "carries" if its trades beat the random ones
 * at |t| ≥ 2 and in both halves of the years; one that trails them the same way
 * is a warning, not an opportunity.
 *
 * Daily closes only: a stop is hit when a close is at or under it, and the
 * trade leaves at that close, so a gap overnight costs what it would. The
 * range inside a day is not seen — in the backtest's older price files there
 * is none — which leaves the stops a little looser than a broker's.
 */

import type { Close } from '../analysis/evaluate.js';
import { BARRIER_SETS, BARRIERS, SETUP_COST_PER_SIDE, SETUPS, walkTrade, type Barriers, type Exit } from '../analysis/setups.js';
import { HALF, splitStat, type SplitStat } from './top-decile.js';

/** One scored company at one month-end: which setups fired (bit k for `SETUPS[k]`), and its typical daily move. */
export interface SetupRecord {
  day:    string;
  symbol: string;
  fires:  number;
  atr:    number;
}

/** Fewer of a setup's trades than this in a month and the month says nothing about it. */
const MIN_TRADES = 3;
/** The rule fixed with the setups. */
export const SETUP_MIN_T = 2;
/** Months a trade can run, for the windows that do not overlap. */
const spanMonths = (b: Barriers) => Math.ceil(b.maxSessions / 21);

export interface TradeStats {
  trades:   number;
  /** Shares ending at the target, at the stop, at the deadline. */
  target:   number;
  stop:     number;
  time:     number;
  /** Mean return per trade after costs. */
  meanRet:  number | null;
  /** Mean sessions held. */
  sessions: number | null;
}

export interface SetupResult extends TradeStats {
  key:   string;
  title: string;
  idea:  string;
  /** Trades a month, on average, over the months it fired in. */
  perMonth: number;
  /** Its trades' mean return minus the month's random ones', every third month; and in each half. */
  excess:   SplitStat;
  first:    SplitStat;
  second:   SplitStat;
  verdict:  'trägt' | 'warnt' | 'nicht belegt';
}

/** The setups under one set of distances. */
export interface SetupGeometry {
  barriers: Barriers;
  /** Whether the rule reads this one; the others are shown. */
  judged:   boolean;
  /** Every stock-month as a trade: the random entry. */
  baseline: TradeStats;
  setups:   SetupResult[];
}

export interface SetupStudy {
  costPerSide: number;
  geometries:  SetupGeometry[];
}

function stats(trades: { exit: Exit; ret: number; sessions: number }[]): TradeStats {
  const n = trades.length;
  const share = (e: Exit) => (n ? trades.filter((t) => t.exit === e).length / n : 0);
  return {
    trades: n, target: share('target'), stop: share('stop'), time: share('time'),
    meanRet: n ? trades.reduce((a, t) => a + t.ret, 0) / n : null,
    sessions: n ? trades.reduce((a, t) => a + t.sessions, 0) / n : null,
  };
}

/** Index of the last close at or before `day`, or −1. */
function at(dates: readonly string[], day: string): number {
  let lo = 0, hi = dates.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= day) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function setupStudy(records: readonly SetupRecord[], prices: ReadonlyMap<string, Close[]>): SetupStudy {
  const series = new Map<string, { dates: string[]; closes: number[] }>();
  for (const [symbol, cs] of prices) series.set(symbol, { dates: cs.map((c) => c.date), closes: cs.map((c) => c.close) });
  // Where each record enters, found once for every set of distances.
  const entries = records.flatMap((r) => {
    const s = series.get(r.symbol);
    const i = s ? at(s.dates, r.day) : -1;
    return s && i >= 0 ? [{ r, closes: s.closes, i }] : [];
  });
  return {
    costPerSide: SETUP_COST_PER_SIDE,
    geometries: BARRIER_SETS.map((b) => geometry(entries, b)),
  };
}

function geometry(entries: { r: SetupRecord; closes: number[]; i: number }[], b: Barriers): SetupGeometry {
  // Every record walked once; the setups pick from the same trades.
  type Trade = { day: string; fires: number; exit: Exit; ret: number; sessions: number };
  const trades: Trade[] = [];
  for (const { r, closes, i } of entries) {
    const t = walkTrade(closes, i, r.atr, b);
    if (!t) continue;
    trades.push({ day: r.day, fires: r.fires, exit: t.exit, sessions: t.sessions, ret: (1 + t.ret) * (1 - SETUP_COST_PER_SIDE) ** 2 - 1 });
  }

  const byDay = new Map<string, Trade[]>();
  for (const t of trades) (byDay.get(t.day) ?? byDay.set(t.day, []).get(t.day)!).push(t);
  const days = [...byDay.keys()].sort();
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const span = spanMonths(b);

  const setups = SETUPS.map((setup, k): SetupResult => {
    const bit = 1 << k;
    const mine = trades.filter((t) => t.fires & bit);
    const all: number[] = [], first: number[] = [], second: number[] = [];
    let months = 0;
    days.forEach((day, m) => {
      const month = byDay.get(day)!;
      const fired = month.filter((t) => t.fires & bit);
      if (fired.length) months++;
      if (fired.length < MIN_TRADES || m % span !== 0) return;
      const d = mean(fired.map((t) => t.ret)) - mean(month.map((t) => t.ret));
      all.push(d);
      (day < HALF ? first : second).push(d);
    });
    const excess = splitStat(all), x = splitStat(first), y = splitStat(second);
    const both = (sign: number) => Math.sign(x.mean ?? 0) === sign && Math.sign(y.mean ?? 0) === sign;
    const t = excess.t ?? 0;
    return {
      key: setup.key, title: setup.title, idea: setup.idea,
      ...stats(mine),
      perMonth: months ? mine.length / months : 0,
      excess, first: x, second: y,
      verdict: t >= SETUP_MIN_T && both(1) ? 'trägt' : t <= -SETUP_MIN_T && both(-1) ? 'warnt' : 'nicht belegt',
    };
  });

  return { barriers: b, judged: b === BARRIERS, baseline: stats(trades), setups };
}
