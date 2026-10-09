/**
 * The depot's night watch: after the nightly refresh, each stock held is
 * checked against three things, all arithmetic, none a model's reading —
 *
 * - the close under the trailing stop the last depot check named, as a broker
 *   runs it: its width under the highest close since the check. Not the
 *   chandelier recomputed every night — in the backtest that closed nearly
 *   every position within a few weeks (`backtest/stops.ts`), which makes it a
 *   signal for everything;
 * - the close under the stop the last depot check worked out — a stop is set
 *   once and stays, so it is the check's, not one recomputed under tonight's
 *   price;
 * - a score under the depot check's reduce bar while the chart's trend reads
 *   down (`chart-reading.ts`), the check's „Reduzieren ansehen“ without the
 *   model's chart reading.
 *
 * Of the two levels, only the one the depot manager chose for the stock is
 * watched — the stop or the trailing stop, its own stop level where it took
 * one from the owner's note; none where it chose none.
 *
 * A signal is announced the night it appears, not every night it lasts: what
 * was announced is remembered, and a signal that clears is forgotten, so it
 * is news again if it returns. The table on the depot page shows the signals
 * standing tonight.
 *
 * Pure and dependency-free: the web app imports the types.
 */

export const WATCH_KINDS = ['trailing', 'stop', 'reduce'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export interface WatchSignal {
  kind:  WatchKind;
  /** For the chip. */
  label: string;
  /** The sentence, with the prices. */
  text:  string;
}

export interface WatchInput {
  close:       number | null;
  currency:    string | null;
  /** The last check's trailing stop under the highest close since. */
  trailing:    number | null;
  /** The last depot check's stop. */
  stop:        number | null;
  score:       number | null;
  /** Whether the chart's trend reads down. */
  falling:     boolean;
  reduceBelow: number;
  /** How a price is written: the caller knows the locale. */
  price:       (n: number, currency: string | null) => string;
}

const num = (x: number) => x.toFixed(1).replace('.', ',');

/** The signals standing for one stock tonight. */
export function watchSignals(w: WatchInput): WatchSignal[] {
  const out: WatchSignal[] = [];
  const close = w.close;
  if (close !== null && w.trailing !== null && close < w.trailing) {
    out.push({
      kind: 'trailing', label: 'unter Trailing',
      text: `Schluss ${w.price(close, w.currency)} unter dem Trailing-Stop des letzten Depot-Checks, der jetzt bei ${w.price(w.trailing, w.currency)} steht (sein Abstand unter dem höchsten Schluss seither)`,
    });
  }
  if (close !== null && w.stop !== null && close < w.stop) {
    out.push({
      kind: 'stop', label: 'unter Stop',
      text: `Schluss ${w.price(close, w.currency)} unter dem Stop des letzten Depot-Checks bei ${w.price(w.stop, w.currency)}`,
    });
  }
  if (w.score !== null && w.score < w.reduceBelow && w.falling) {
    out.push({
      kind: 'reduce', label: 'schwach, Chart fällt',
      text: `Score ${num(w.score)} unter ${num(w.reduceBelow)} und der Chart zeigt abwärts`,
    });
  }
  return out;
}

/** What tonight's signals hold that the last announcement did not, by ticker. */
export function newSignals(
  now: Readonly<Record<string, readonly WatchKind[]>>, before: Readonly<Record<string, readonly WatchKind[]>>,
): Record<string, WatchKind[]> {
  const out: Record<string, WatchKind[]> = {};
  for (const [symbol, kinds] of Object.entries(now)) {
    const fresh = kinds.filter((k) => !(before[symbol] ?? []).includes(k));
    if (fresh.length) out[symbol] = fresh;
  }
  return out;
}
