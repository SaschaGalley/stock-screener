/**
 * What the market looked like on the day of a purchase or a sale.
 *
 * Buying what has just jumped — after a run, on heavy volume, a few days
 * before the numbers — is the most common way private investors lose money,
 * and the hardest to see in the moment. These are the facts that show it,
 * read from the stored prices and our own score as of any day: shown in the
 * editor before a purchase is entered, and on the entry afterwards, so a
 * reason can be read beside the situation it was written in.
 *
 * Pure and dependency-free so the web app can import the types.
 */

import { bigMoves } from './timeline.js';

export interface EntryBar { day: string; close: number; volume: number | null }

export interface EntryContext {
  symbol:    string;
  /** The close the situation is read at — the day itself, or the last trading day before it. */
  asOf:      string | null;
  close:     number | null;
  /** Over the last 5 and 20 trading days up to `asOf`. */
  change5:   number | null;
  change20:  number | null;
  /** Distance below the highest close of the year before, ≤ 0. */
  fromHigh:  number | null;
  /** Above the lowest close of the year before, ≥ 0. */
  fromLow:   number | null;
  /** The last 5 days' average volume over the 50 days before them. */
  volumeRatio: number | null;
  /** Days within the last ten that moved further than the stock usually does. */
  jumps:     { day: string; change: number }[];
  /** Our own score and verdict as they stood. */
  score:     number | null;
  verdict:   string | null;
  /** A report due within the next week, when one was scheduled. */
  earnings:  string | null;
  /** What stands out, as sentences. Empty when nothing does. */
  flags:     string[];
  /**
   * Whether the market had just done something to prompt the trade — a run, a
   * jump, a crowd, the year's extreme, a report days away — as opposed to the
   * model's verdict, which is a reason of a different kind.
   */
  impulse:   boolean;
}

const DAY_MS = 86_400_000;
const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`;
const fmtDay = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`;

const MODEL_FLAG = 'Modell-Urteil';
/** How far a stock has to move in five days before it counts as a run. */
const RUN = 0.10;
/** Volume this many times the usual is a crowd. */
const CROWD = 2;
/** Within this of the year's high or low is "at" it. */
const NEAR_EXTREME = 0.03;
/**
 * …but only after a climb or a fall of this much from the other end: a stock
 * that has moved 2 % all year is at its high every other week.
 */
const SWING = 0.15;

/**
 * The situation of `symbol` on `day`, from its bars (oldest first, at least a
 * year of them for the high, the low and the jumps) and our score then.
 */
export function entryContext(
  symbol: string,
  kind: 'buy' | 'sell' | 'note',
  day: string,
  bars: EntryBar[],
  model: { score: number | null; verdict: string | null },
  nextEarnings: string | null,
): EntryContext {
  const upTo = bars.filter((b) => b.day <= day);
  const last = upTo[upTo.length - 1];
  const at = (n: number) => upTo[upTo.length - 1 - n];
  const change = (n: number) => (last && at(n) && at(n).close > 0 ? last.close / at(n).close - 1 : null);
  const yearAgo = new Date(Date.parse(day) - 365 * DAY_MS).toISOString().slice(0, 10);
  const year = upTo.filter((b) => b.day >= yearAgo);
  const high = year.length >= 20 ? Math.max(...year.map((b) => b.close)) : null;
  const low = year.length >= 20 ? Math.min(...year.map((b) => b.close)) : null;

  const vols = upTo.map((b) => b.volume);
  const recent = vols.slice(-5);
  const before = vols.slice(-55, -5);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null && x > 0);
    return v.length >= Math.ceil(xs.length * 0.8) && v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const recentAvg = recent.length === 5 ? avg(recent) : null;
  const beforeAvg = before.length >= 40 ? avg(before) : null;
  const volumeRatio = recentAvg !== null && beforeAvg ? recentAvg / beforeAvg : null;

  const tenDaysAgo = new Date(Date.parse(day) - 10 * DAY_MS).toISOString().slice(0, 10);
  // The timeline's own test for a jump; it speaks in titles, so the size is read back from the bars.
  const jumps = bigMoves(upTo, yearAgo)
    .filter((m) => m.day >= tenDaysAgo)
    .map((m) => {
      const i = upTo.findIndex((b) => b.day === m.day);
      return { day: m.day, change: upTo[i].close / upTo[i - 1].close - 1 };
    });

  const earnings = nextEarnings && nextEarnings >= day
    && Date.parse(nextEarnings) - Date.parse(day) <= 7 * DAY_MS ? nextEarnings : null;

  const c5 = change(5);
  const c20 = change(20);
  const fromHigh = high && last ? last.close / high - 1 : null;
  const fromLow = low && last ? last.close / low - 1 : null;

  const flags: string[] = [];
  const buying = kind !== 'sell';
  if (c5 !== null && (buying ? c5 >= RUN : c5 <= -RUN)) flags.push(`${pct(c5)} in den fünf Handelstagen davor`);
  for (const j of jumps) {
    if (buying ? j.change > 0 : j.change < 0) flags.push(`Kurssprung ${pct(j.change)} am ${fmtDay(j.day)}`);
  }
  if (volumeRatio !== null && volumeRatio >= CROWD) {
    flags.push(`Handelsvolumen ${volumeRatio.toFixed(1).replace('.', ',')}-mal so hoch wie üblich`);
  }
  if (fromHigh !== null && fromLow !== null) {
    if (buying && fromHigh >= -NEAR_EXTREME && fromLow >= SWING) flags.push(`am Jahreshoch, ${pct(fromLow)} über dem Tief`);
    if (!buying && fromLow <= NEAR_EXTREME && fromHigh <= -SWING) flags.push(`am Jahrestief, ${pct(fromHigh)} unter dem Hoch`);
  }
  if (model.verdict) {
    const v = model.verdict.toUpperCase();
    const score = model.score !== null ? ` (Score ${model.score.toFixed(1).replace('.', ',')})` : '';
    if (buying && v.includes('SELL')) flags.push(`${MODEL_FLAG} ${model.verdict}${score}`);
    if (!buying && v.includes('BUY')) flags.push(`${MODEL_FLAG} ${model.verdict}${score}`);
  }
  if (earnings) flags.push(`Quartalszahlen am ${fmtDay(earnings)} — ${buying ? 'gekauft' : 'verkauft'} kurz davor`);
  const impulse = flags.some((f) => !f.startsWith(MODEL_FLAG));

  return {
    symbol, asOf: last?.day ?? null, close: last?.close ?? null,
    change5: c5, change20: c20, fromHigh, fromLow, volumeRatio, jumps,
    score: model.score, verdict: model.verdict, earnings, flags, impulse,
  };
}
