/**
 * When to buy, as distinct from whether.
 *
 * The score asks whether a stock is worth owning — its price against what it is
 * worth, the business, the trend of the last year. It does not ask where the
 * price sits on its recent path: whether it just fell for a month, sits at the
 * lower edge of its channel, under its moving averages, or has just bounced off
 * its low. Those are the questions a chart is read for, and they were asked of
 * no stock at all.
 *
 * Each is put here as a candidate first, as the insider signals were: a
 * reading, the claim made for it, and the backtest's verdict on whether the
 * claim held (`backtest/timing.ts`). None of them votes in the score.
 *
 * Every candidate is turned the dip buyer's way — more is deeper down: a bigger
 * fall, lower RSI, further under the average, nearer the low. A positive IC
 * says buying weakness paid; a negative one says the trend won and the dip
 * kept dipping. Both are answers, and the second is what the momentum
 * literature expects for everything longer than a month.
 *
 * One function computes the readings for the live technicals and for the
 * backtest's month-ends, from the same adjusted closes in both, so what the
 * page shows is what was measured.
 */

import type { TimingReadings } from '../types.js';

/** Sessions in a month, a quarter and half a year, as the other technicals count them. */
const MONTH = 21;
const QUARTER = 63;
const HALF_YEAR = 126;
/** Closes the readings need at most: the 200-day line, and RSI's smoothing warmed up over the year. */
export const TIMING_LOOKBACK = 253;

/**
 * A bounce, fixed before the backtest saw it: the six-month low was made at
 * least three and at most fifteen sessions ago, and the price has come back
 * five percent from it since. Without the three a stock still falling into its
 * low would count; without the fifteen a recovery that is already a trend.
 */
export const BOUNCE = { minAgo: 3, maxAgo: 15, minRise: Math.log(1.05) } as const;

function sma(closes: readonly number[], n: number): number | null {
  if (closes.length < n) return null;
  let s = 0;
  for (let k = closes.length - n; k < closes.length; k++) s += closes[k];
  return s / n;
}

/** Wilder's RSI over the closes given — the first 14 changes seed it, the rest smooth it. */
function rsi(closes: readonly number[], n = 14): number | null {
  if (closes.length < n * 2 + 1) return null;
  let gain = 0, loss = 0;
  for (let k = 1; k <= n; k++) {
    const d = closes[k] - closes[k - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let k = n + 1; k < closes.length; k++) {
    const d = closes[k] - closes[k - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * The quarter's channel: a straight line through the log closes of the last
 * 63 sessions, and how far the last close sits from it in the residuals' own
 * standard deviations. +2 is the upper edge of a channel, −2 the lower,
 * whichever way the channel points; the slope says which way that is.
 */
function channel(closes: readonly number[]): { z: number | null; slope: number | null } {
  if (closes.length < QUARTER) return { z: null, slope: null };
  const ys = closes.slice(-QUARTER).map(Math.log);
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let k = 0; k < n; k++) { sxy += (k - mx) * (ys[k] - my); sxx += (k - mx) ** 2; }
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let k = 0; k < n; k++) ss += (ys[k] - (a + b * k)) ** 2;
  const sd = Math.sqrt(ss / (n - 2));
  const last = ys[n - 1] - (a + b * (n - 1));
  return { z: sd > 0 ? last / sd : null, slope: b * 252 };
}

/**
 * Where the price sits on its own recent path, from adjusted closes, oldest
 * first. Null when there is less than a year of them: the 200-day line
 * and a warmed-up RSI need it, and a reading on half its window is a
 * different reading.
 */
export function timingReadings(closes: readonly number[]): TimingReadings | null {
  if (closes.length < TIMING_LOOKBACK || closes.some((c) => !(c > 0))) return null;
  const xs = closes.slice(-TIMING_LOOKBACK);
  const price = xs[xs.length - 1];
  const s50 = sma(xs, 50), s200 = sma(xs, 200);
  const half = xs.slice(-HALF_YEAR);
  let low = Infinity, lowAt = 0;
  // The newest low wins a tie: a stock that revisits its low is at it today.
  half.forEach((c, k) => { if (c <= low) { low = c; lowAt = k; } });
  const ch = channel(xs);
  return {
    m1:          price / xs[xs.length - 1 - MONTH] - 1,
    rsi14:       rsi(xs),
    distSma50:   s50 ? Math.log(price / s50) : null,
    distSma200:  s200 ? Math.log(price / s200) : null,
    channelZ:    ch.z,
    channelSlope: ch.slope,
    fromLow126:  Math.log(price / low),
    lowAgo:      half.length - 1 - lowAt,
  };
}

export interface TimingCandidate {
  key:   string;
  title: string;
  /** What is read, without the claim: the label beside a stock's own value. */
  short: string;
  /** The claim, as those who read the chart this way make it. */
  claim: string;
  /** The reading turned so that more is deeper down; null where it has none. */
  read:  (t: TimingReadings) => number | null;
}

/**
 * The candidates, each turned so that more means deeper down. Fixed before the
 * first backtest of them, with the bounce's thresholds above: changing one
 * after reading the result would be fitting it.
 */
export const TIMING_CANDIDATES: readonly TimingCandidate[] = [
  { key: 'timing.reversal-1m', title: 'Rückgang im letzten Monat',
    short: 'Letzter Monat',
    claim: 'Was einen Monat lang fiel, holt einen Teil davon wieder auf (kurzfristige Umkehr).',
    read: (t) => -t.m1 },
  { key: 'timing.rsi', title: 'RSI 14 niedrig (überverkauft)',
    short: 'RSI 14',
    claim: 'Ein niedriger RSI zeigt eine überverkaufte Aktie, die zurückfedert.',
    read: (t) => (t.rsi14 === null ? null : 50 - t.rsi14) },
  { key: 'timing.sma50', title: 'Unter der 50-Tage-Linie',
    short: '50-Tage-Linie',
    claim: 'Ein Rücksetzer unter die 50-Tage-Linie ist ein günstiger Einstieg.',
    read: (t) => (t.distSma50 === null ? null : -t.distSma50) },
  { key: 'timing.sma200', title: 'Unter der 200-Tage-Linie',
    short: '200-Tage-Linie',
    claim: 'Weit unter der 200-Tage-Linie ist die Aktie ausgebombt; darüber ist sie heißgelaufen.',
    read: (t) => (t.distSma200 === null ? null : -t.distSma200) },
  { key: 'timing.channel', title: 'Unterer Rand des 3-Monats-Kanals',
    short: '3-Monats-Kanal',
    claim: 'Am unteren Rand ihres Kanals dreht die Aktie nach oben, am oberen nach unten.',
    read: (t) => (t.channelZ === null ? null : -t.channelZ) },
  { key: 'timing.support', title: 'Nähe zum 6-Monats-Tief',
    short: '6-Monats-Tief',
    claim: 'Nahe am Tief hält die Unterstützung; der Weg nach unten ist kurz.',
    read: (t) => -t.fromLow126 },
  { key: 'timing.bounce', title: 'Abprall vom 6-Monats-Tief',
    short: 'Abprall vom Tief',
    claim: 'Eine Aktie, die gerade von ihrem Tief abgeprallt ist, hat den Boden gefunden.',
    read: (t) => (t.lowAgo >= BOUNCE.minAgo && t.lowAgo <= BOUNCE.maxAgo && t.fromLow126 >= BOUNCE.minRise ? 1 : 0) },
];

/**
 * The verdicts the backtest splits within. The strength is left out: the
 * STRONG labels alone are too thin a slice of a month to halve.
 */
export const TIMING_GROUPS = [
  { key: 'all',  label: 'alle Aktien' },
  { key: 'buy',  label: 'BUY und STRONG BUY' },
  { key: 'hold', label: 'HOLD' },
  { key: 'sell', label: 'SELL und STRONG SELL' },
] as const;
export type TimingGroup = Exclude<(typeof TIMING_GROUPS)[number]['key'], 'all'>;

/** A verdict's group. */
export function timingGroup(verdict: string): TimingGroup {
  const v = verdict.toUpperCase();
  return v.includes('BUY') ? 'buy' : v.includes('SELL') ? 'sell' : 'hold';
}
