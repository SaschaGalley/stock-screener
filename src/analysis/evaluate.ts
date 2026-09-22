/**
 * Does the score say anything about what the price did next?
 *
 * Everything else in the scoring code is about *internal* quality — the
 * findings add up, missing data costs coverage, two runs agree. None of that
 * says whether a 7 was followed by better returns than a 4. This module is the
 * only place that asks, and it asks the way factor research does:
 *
 *   - **Rank information coefficient.** On every trading day, rank the stocks by
 *     the score they had going into that day and by the return they went on to
 *     make over the next `h` sessions, and correlate the two rankings. A
 *     cross-section cancels the market: a day on which everything fell still
 *     says whether the high scores fell less.
 *   - **Per signal.** The headline, the factor half, and every pillar are
 *     evaluated separately, so the pillar weights can eventually be argued
 *     from outcomes instead of set by taste.
 *   - **Honest about overlap.** Consecutive 20-day windows share 19 days, so
 *     their ICs are nowhere near independent. The mean uses every day; the
 *     t-statistic uses only non-overlapping windows, which is the count that
 *     actually carries information.
 *
 * Point in time: a signal is read from observations dated strictly *before*
 * the formation day and the return runs from that day's close, so nothing the
 * score saw can be part of the return it is credited with.
 *
 * Pure — prices and observations come in, numbers go out — so it can be tested
 * without a database or a market-data call.
 */

/** One stored value of one signal. */
export interface SignalPoint {
  at:    Date;
  value: number | null;
  text?: string | null;
}

/** A daily close, keyed by the exchange's calendar date. */
export interface Close { date: string; close: number }

export interface EvaluationInput {
  /** signal key → symbol → points, oldest first. */
  signals:   Map<string, Map<string, SignalPoint[]>>;
  /** symbol → closes, oldest first. */
  prices:    Map<string, Close[]>;
  /** The benchmark's closes; its dates are the calendar the evaluation walks. */
  benchmark: Close[];
  horizons:  number[];
  /** Signal whose `text` is the verdict label, for the per-label returns. */
  labelKey?: string;
}

export interface IcSummary {
  key:              string;
  horizon:          number;
  /** Formation days with a usable cross-section. */
  days:             number;
  /** Non-overlapping windows — the sample size the t-statistic rests on. */
  independent:      number;
  meanIc:           number | null;
  /** Mean IC over non-overlapping windows divided by its standard error. */
  tStat:            number | null;
  /** Share of formation days with a positive IC. */
  hitRate:          number | null;
  /** Mean excess return of the top third minus the bottom third, per window. */
  spread:           number | null;
  meanCrossSection: number | null;
}

export interface LabelReturn {
  horizon:     number;
  label:       string;
  /** Stock-windows pooled over non-overlapping formation days. */
  count:       number;
  /** Mean return over the benchmark across those windows. */
  meanExcess:  number | null;
}

export interface Evaluation {
  from:     string | null;
  to:       string | null;
  symbols:  number;
  ics:      IcSummary[];
  labels:   LabelReturn[];
}

/**
 * Fewest stocks a formation day needs before its rank correlation is read.
 *
 * With n stocks the standard error of a rank correlation under no relationship
 * is about 1/√(n−1): at 10 it is ±0.33, which is already wide, and below that a
 * single day's IC is mostly the noise of who happened to be in the sample.
 */
export const MIN_CROSS_SECTION = 10;

/** Non-overlapping windows needed before a t-statistic is reported at all. */
export const MIN_INDEPENDENT = 3;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Average ranks, ties sharing the mean of the positions they span. */
export function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 2) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  // A cross-section in which every stock has the same score ranks nothing.
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation. */
export function spearman(x: number[], y: number[]): number | null {
  return pearson(ranks(x), ranks(y));
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * How long a series' *final* point keeps counting after the series stops.
 *
 * A series that ended — the old single-call LLM score stops in August, a symbol
 * leaves the watchlist — would otherwise be carried forward for ever and
 * credited with returns it never saw. Gaps *inside* a series are left alone:
 * a snapshot is only written when its content changes, so a quiet week is the
 * same score still holding, not a missing one.
 */
export const MAX_SIGNAL_AGE_DAYS = 10;

/** Newest point dated strictly before `day`, unless the series ended long before. */
function valueBefore(points: SignalPoint[], day: string): SignalPoint | null {
  let index = -1;
  for (let i = 0; i < points.length; i++) {
    if (isoDate(points[i].at) >= day) break;
    index = i;
  }
  if (index < 0) return null;
  const found = points[index];
  if (index < points.length - 1) return found;
  const age = (Date.parse(day) - Date.parse(isoDate(found.at))) / 86_400_000;
  return age <= MAX_SIGNAL_AGE_DAYS ? found : null;
}

/**
 * Close on the last session at or before `day`.
 *
 * Symbols trade on their own calendars — a Paris listing is shut on days New
 * York is open — so the benchmark's day is mapped onto each symbol's nearest
 * earlier session rather than required to exist in it.
 */
function closeAtOrBefore(closes: Close[], day: string): number | null {
  let lo = 0, hi = closes.length - 1, found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closes[mid].date <= day) { found = closes[mid].close; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}

function forwardReturn(closes: Close[] | undefined, from: string, to: string): number | null {
  if (!closes?.length || closes[0].date > from) return null;
  const a = closeAtOrBefore(closes, from);
  const b = closeAtOrBefore(closes, to);
  return a && b && a > 0 ? b / a - 1 : null;
}

interface Window { day: string; exit: string; bench: number }

/** Every formation day on which a full `h`-session window has already closed. */
function windowsFor(benchmark: Close[], h: number, firstSignal: string): Window[] {
  const out: Window[] = [];
  for (let i = 0; i + h < benchmark.length; i++) {
    const day = benchmark[i].date;
    if (day <= firstSignal) continue;
    const bench = benchmark[i + h].close / benchmark[i].close - 1;
    out.push({ day, exit: benchmark[i + h].date, bench });
  }
  return out;
}

export function evaluate(input: EvaluationInput): Evaluation {
  const { signals, prices, benchmark, horizons, labelKey } = input;

  let first: string | null = null;
  let last: string | null = null;
  const symbols = new Set<string>();
  for (const bySymbol of signals.values()) {
    for (const [symbol, points] of bySymbol) {
      if (!points.length) continue;
      symbols.add(symbol);
      const a = isoDate(points[0].at);
      const b = isoDate(points[points.length - 1].at);
      if (first === null || a < first) first = a;
      if (last === null || b > last) last = b;
    }
  }

  const ics: IcSummary[] = [];
  const labels: LabelReturn[] = [];
  if (first === null) return { from: null, to: null, symbols: 0, ics, labels };

  for (const h of horizons) {
    const windows = windowsFor(benchmark, h, first);

    for (const [key, bySymbol] of signals) {
      if (key === labelKey) continue;
      const daily: { ic: number; spread: number | null; n: number }[] = [];
      const independent: number[] = [];

      windows.forEach((w, i) => {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const [symbol, points] of bySymbol) {
          const v = valueBefore(points, w.day)?.value;
          if (v == null || !Number.isFinite(v)) continue;
          const r = forwardReturn(prices.get(symbol), w.day, w.exit);
          if (r === null) continue;
          xs.push(v);
          ys.push(r - w.bench);
        }
        if (xs.length < MIN_CROSS_SECTION) return;
        const ic = spearman(xs, ys);
        if (ic === null) return;

        // Terciles by the signal's rank; the spread is what a long-top,
        // short-bottom book would have earned, before any cost.
        const rk = ranks(xs);
        const third = xs.length / 3;
        const top = ys.filter((_, k) => rk[k] > xs.length - third);
        const bottom = ys.filter((_, k) => rk[k] <= third);
        const t = mean(top), b = mean(bottom);
        daily.push({ ic, spread: t !== null && b !== null ? t - b : null, n: xs.length });
        if (i % h === 0) independent.push(ic);
      });

      const m = mean(independent);
      let tStat: number | null = null;
      if (m !== null && independent.length >= MIN_INDEPENDENT) {
        const sd = Math.sqrt(
          independent.reduce((a, x) => a + (x - m) ** 2, 0) / (independent.length - 1),
        );
        tStat = sd > 0 ? m / (sd / Math.sqrt(independent.length)) : null;
      }

      ics.push({
        key, horizon: h,
        days:             daily.length,
        independent:      independent.length,
        meanIc:           mean(daily.map((d) => d.ic)),
        tStat,
        hitRate:          daily.length ? daily.filter((d) => d.ic > 0).length / daily.length : null,
        spread:           mean(daily.map((d) => d.spread).filter((s): s is number => s !== null)),
        meanCrossSection: mean(daily.map((d) => d.n)),
      });
    }

    if (labelKey && signals.has(labelKey)) {
      const bySymbol = signals.get(labelKey)!;
      const pooled = new Map<string, number[]>();
      windows.forEach((w, i) => {
        if (i % h !== 0) return;
        for (const [symbol, points] of bySymbol) {
          const label = valueBefore(points, w.day)?.text;
          if (!label) continue;
          const r = forwardReturn(prices.get(symbol), w.day, w.exit);
          if (r === null) continue;
          const list = pooled.get(label) ?? [];
          list.push(r - w.bench);
          pooled.set(label, list);
        }
      });
      for (const [label, rs] of pooled) {
        labels.push({ horizon: h, label, count: rs.length, meanExcess: mean(rs) });
      }
    }
  }

  return { from: first, to: last, symbols: symbols.size, ics, labels };
}
