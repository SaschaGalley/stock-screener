/**
 * Where a position could be protected, from its chart alone: a stop under the
 * support the price stands on, and a trailing stop that follows the high — in
 * the stock's own currency and as distances from today's close.
 *
 * Neither is a forecast. A stop limits what a position can lose; it adds no
 * return. Kaminski and Lo (2014) show a stop rule pays only where prices trend
 * — under a random walk it sells into the rebounds and costs what it saves —
 * and Han, Zhou and Zhu (2016) found the trending case in momentum. The
 * backtest (`backtest/stops.ts`, S&P 1500 since 2013) put both levels to the
 * test against holding: the stop fired on half the positions within three
 * months, the trailing stop on four in five, and with the money left in cash
 * they cost 3.8 and 6.1 points over six months, in both halves of the years;
 * with the money put into the index at once they cost nothing measurable,
 * except on the big winners. The worst twentieth went from −30 % to −17 % and
 * −13 %. So these are levels to look at, said in the chart's own terms:
 *
 * - The stop goes half a daily move (ATR) under the nearest support at least
 *   1½ daily moves below the close. Nearer, an ordinary day would take it out;
 *   under the level rather than at it, because stops gather at levels and a
 *   wick through one is not a break. A support more than four daily moves down
 *   is too far for a stop — on a stock that moves 4 % a day it would give back
 *   a sixth of the position before it acted — and then the stop sits three
 *   daily moves under the close, where the chandelier would put it too.
 * - The trailing stop is LeBeau's chandelier exit: three daily moves under the
 *   highest high of the last 22 sessions. Its width — the distance from that
 *   high — is what a broker's trailing order asks for.
 *
 * Pure and dependency-free: the web app imports the types.
 */

import type { ChartAnalysis, ChartBar } from './chart.js';
import { channelPlace } from './chart-reading.js';

/** A support nearer than this many daily moves is inside the day's noise. */
export const STOP_MIN_ATR = 1.5;
/** …and one further than this is no stop for a position, it is a different chart. */
export const STOP_MAX_ATR = 4;
/** How far under the support the stop sits. */
export const STOP_BUFFER_ATR = 0.5;
/** Without a support in reach: this many daily moves under the close. */
export const STOP_FALLBACK_ATR = 3;
/** The chandelier: this many daily moves under the high of… */
export const TRAIL_ATR = 3;
/** …this many sessions. */
export const TRAIL_SESSIONS = 22;

export interface Protection {
  asOf:      string;
  close:     number;
  currency:  string | null;
  /** ATR(14) over the close: how far the price typically moves in a day. */
  dailyMove: number | null;
  /** The stop and where it comes from; `distance` from the close, negative. */
  stop: {
    price:    number;
    distance: number;
    basis:    'support' | 'atr';
    /** The support it sits under, when it sits under one. */
    level:    number | null;
  } | null;
  /** The chandelier: `width` from the 22-day high, `distance` from the close. */
  trailing: { price: number; high: number; width: number; distance: number } | null;
  rsi:       number | null;
  /** The close against the 200-day line: 0.12 is 12 % above it. */
  overSma200: number | null;
  /** Where in the three-month channel. */
  channel:   ReturnType<typeof channelPlace> | null;
  /** The nearest resistance above, from the close; null at the high. */
  resistance: number | null;
}

/** The protection levels of a chart. `bars` are the ones `a` was read from, oldest first. */
export function protectionOf(bars: readonly ChartBar[], a: ChartAnalysis, currency: string | null = null): Protection {
  const { close, atr } = a;
  const supports = a.levels
    .filter((l) => l.price < close && l.distanceAtr !== null && -l.distanceAtr >= STOP_MIN_ATR && -l.distanceAtr <= STOP_MAX_ATR)
    .sort((x, y) => y.price - x.price);
  const resistances = a.levels.filter((l) => l.price > close).sort((x, y) => x.price - y.price);

  let stop: Protection['stop'] = null;
  if (atr !== null && atr > 0) {
    const level = supports[0]?.price ?? null;
    const price = level !== null ? level - STOP_BUFFER_ATR * atr : close - STOP_FALLBACK_ATR * atr;
    if (price > 0) stop = { price, distance: price / close - 1, basis: level !== null ? 'support' : 'atr', level };
  }

  let trailing: Protection['trailing'] = null;
  const recent = bars.slice(-TRAIL_SESSIONS);
  if (atr !== null && atr > 0 && recent.length > 0) {
    const high = Math.max(...recent.map((b) => b.high ?? b.close));
    const price = high - TRAIL_ATR * atr;
    if (price > 0) trailing = { price, high, width: 1 - price / high, distance: price / close - 1 };
  }

  const quarter = a.channels.find((c) => c.sessions === 63);
  return {
    asOf: a.asOf, close, currency,
    dailyMove: atr !== null ? atr / close : null,
    stop, trailing,
    rsi: a.rsi14,
    overSma200: a.ma.sma200 !== null && a.ma.sma200 > 0 ? close / a.ma.sma200 - 1 : null,
    channel: quarter ? channelPlace(quarter) : null,
    resistance: resistances[0] ? resistances[0].price / close - 1 : null,
  };
}
