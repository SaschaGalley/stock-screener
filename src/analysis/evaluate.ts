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
 *   - **Within sectors as well.** A score that likes banks is right in a year
 *     banks rally and says nothing about which bank to own. The sector-neutral
 *     IC ranks each stock against its own sector and each return against its
 *     sector's mean, so an industry bet cannot pass for stock picking.
 *   - **In one currency.** Returns are measured against the S&P 500 in dollars,
 *     so the caller converts every other listing to dollars first
 *     (`inCommonCurrency`). A Paris listing measured in euros against a dollar
 *     index credits the score with the exchange rate.
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
  /** symbol → sector, for the sector-neutral IC; left out, it is not computed. */
  sectors?:  Map<string, string>;
  /** Keep every formation day's IC, for a table by year — the backtest's, not the page's. */
  keepDaily?: boolean;
}

export interface IcSummary {
  key:              string;
  horizon:          number;
  /** Formation days with a usable cross-section. */
  days:             number;
  /** Non-overlapping windows — the sample size the t-statistic rests on. */
  independent:      number;
  meanIc:           number | null;
  /** Standard error of the mean IC, from the non-overlapping windows. */
  se:               number | null;
  /** Mean IC over non-overlapping windows divided by its standard error. */
  tStat:            number | null;
  /** Mean rank IC within sectors (`sectorNeutralIc`); null without sectors. */
  neutralIc:        number | null;
  neutralTStat:     number | null;
  /** Every formation day's IC, when asked for (`keepDaily`). */
  daily?:           { day: string; ic: number; neutralIc: number | null }[];
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

/**
 * Fewest stocks of one sector in a cross-section before the sector counts in
 * the sector-neutral IC. Two is the least that can be ranked against each
 * other; a sector of one has nothing to be neutral against.
 */
export const MIN_SECTOR_SIZE = 2;

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

/** Mean, standard error and t of a sample of independent ICs; null below `MIN_INDEPENDENT`. */
export function meanTest(xs: number[]): { se: number | null; t: number | null } {
  const m = mean(xs);
  if (m === null || xs.length < MIN_INDEPENDENT) return { se: null, t: null };
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  const se = sd / Math.sqrt(xs.length);
  return { se, t: se > 0 ? m / se : null };
}

/**
 * Rank IC within sectors, pooled.
 *
 * Each stock's signal becomes its centred percentile among its own sector's
 * stocks and each return its distance from the sector's mean, and the two are
 * rank-correlated across all sectors at once. A sector that did well as a
 * whole, and happened to score well as a whole, contributes nothing; a sector
 * in which the higher scores did better contributes, whatever the sector did.
 */
export function sectorNeutralIc(
  xs: number[], ys: number[], sectors: (string | null | undefined)[],
): number | null {
  const groups = new Map<string, number[]>();
  sectors.forEach((s, i) => {
    if (!s) return;
    const g = groups.get(s) ?? [];
    g.push(i);
    groups.set(s, g);
  });
  const nx: number[] = [];
  const ny: number[] = [];
  for (const idx of groups.values()) {
    if (idx.length < MIN_SECTOR_SIZE) continue;
    const r = ranks(idx.map((i) => xs[i]));
    const my = mean(idx.map((i) => ys[i]))!;
    idx.forEach((i, k) => {
      nx.push((r[k] - (idx.length + 1) / 2) / idx.length);
      ny.push(ys[i] - my);
    });
  }
  return nx.length >= MIN_CROSS_SECTION ? spearman(nx, ny) : null;
}

/**
 * Closes restated in another currency: each close times the exchange rate of
 * its session (the last one at or before it), in units of the target currency
 * per unit of the listing's. Sessions before the first rate are dropped rather
 * than guessed.
 */
export function inCommonCurrency(closes: Close[], fx: Close[]): Close[] {
  const out: Close[] = [];
  for (const c of closes) {
    const rate = closeAtOrBefore(fx, c.date);
    if (rate !== null && rate > 0) out.push({ date: c.date, close: c.close * rate });
  }
  return out;
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

/**
 * Newest point dated strictly before `day`, unless the series ended long before.
 *
 * A point is dated by its UTC calendar day, so "before `day`" is "before that
 * day's UTC midnight"; the points are oldest first, so it is a binary search.
 */
function valueBefore(points: SignalPoint[], day: string): SignalPoint | null {
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  let lo = 0, hi = points.length - 1, index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].at.getTime() < midnight) { index = mid; lo = mid + 1; }
    else hi = mid - 1;
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
  const { signals, prices, benchmark, horizons, labelKey, sectors, keepDaily } = input;

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
      const neutralDaily: number[] = [];
      const neutralIndependent: number[] = [];
      const kept: { day: string; ic: number; neutralIc: number | null }[] = [];

      windows.forEach((w, i) => {
        const xs: number[] = [];
        const ys: number[] = [];
        const ss: (string | undefined)[] = [];
        for (const [symbol, points] of bySymbol) {
          const v = valueBefore(points, w.day)?.value;
          if (v == null || !Number.isFinite(v)) continue;
          const r = forwardReturn(prices.get(symbol), w.day, w.exit);
          if (r === null) continue;
          xs.push(v);
          ys.push(r - w.bench);
          ss.push(sectors?.get(symbol));
        }
        if (xs.length < MIN_CROSS_SECTION) return;
        const ic = spearman(xs, ys);
        if (ic === null) return;

        let neutral: number | null = null;
        if (sectors) {
          neutral = sectorNeutralIc(xs, ys, ss);
          if (neutral !== null) {
            neutralDaily.push(neutral);
            if (i % h === 0) neutralIndependent.push(neutral);
          }
        }
        if (keepDaily) kept.push({ day: w.day, ic, neutralIc: neutral });

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

      const test = meanTest(independent);

      ics.push({
        key, horizon: h,
        days:             daily.length,
        independent:      independent.length,
        meanIc:           mean(daily.map((d) => d.ic)),
        se:               test.se,
        tStat:            test.t,
        neutralIc:        mean(neutralDaily),
        neutralTStat:     meanTest(neutralIndependent).t,
        ...(keepDaily ? { daily: kept } : {}),
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

/** What one bucket of a signal earned against the average stock of the same months. */
export interface BucketReturn {
  horizon:    number;
  bucket:     string;
  /** Formation months the bucket held a stock in — non-overlapping, one every `horizon`. */
  months:     number;
  /** Stock-windows over those months. */
  count:      number;
  /**
   * The bucket's mean return less the mean of every stock with a reading,
   * averaged over the months: what holding the bucket added to holding them
   * all. Neither the market nor whatever all of them shared — the small caps'
   * lag since 2020 — is in it. Each month's returns are held to its own 2.5th
   * and 97.5th percentiles first (`WINSOR`).
   */
  meanExcess: number | null;
  tStat:      number | null;
  /** Share of the months the bucket did better than the average. */
  hitRate:    number | null;
}

/**
 * How far into each tail a month's returns are held, before buckets average
 * them. One stock that went up eightfold in a year moves a tenth of the index
 * by a whole point and decides which tenth "won" — the rank IC never sees it,
 * the mean of a bucket sees nothing else. Clipped, it still counts as the
 * month's best; it no longer counts as eight of them.
 */
const WINSOR = 0.025;

/**
 * A signal's stocks split into buckets each formation month — its deciles by
 * rank, or buckets of its own (a verdict, a step of the score) — and what each
 * earned against the month's average stock. The question the rank IC answers
 * on the whole, asked of each part: does the top tenth earn more than the
 * next, does a STRONG BUY earn more than a BUY.
 */
export function bucketReturns(input: {
  points:    ReadonlyMap<string, SignalPoint[]>;
  prices:    ReadonlyMap<string, Close[]>;
  benchmark: Close[];
  horizons:  number[];
  /** `decile` ranks each month's readings into ten; a function names a reading's bucket. */
  bucket:    'decile' | ((p: SignalPoint) => string | null);
  /** Only formation days in [from, to): a part of the years, without copying the points. */
  range?:    { from?: string; to?: string };
}): BucketReturn[] {
  let first: string | null = null;
  for (const points of input.points.values()) {
    if (points.length && (first === null || isoDate(points[0].at) < first)) first = isoDate(points[0].at);
  }
  if (first === null) return [];
  const out: BucketReturn[] = [];
  for (const h of input.horizons) {
    const diffs = new Map<string, number[]>();
    const counts = new Map<string, number>();
    windowsFor(input.benchmark, h, first).forEach((w, i) => {
      if (i % h !== 0) return;
      if ((input.range?.from && w.day < input.range.from) || (input.range?.to && w.day >= input.range.to)) return;
      const rows: { value: number; point: SignalPoint; r: number }[] = [];
      for (const [symbol, points] of input.points) {
        const p = valueBefore(points, w.day);
        if (!p) continue;
        const r = forwardReturn(input.prices.get(symbol), w.day, w.exit);
        if (r === null) continue;
        rows.push({ value: p.value ?? NaN, point: p, r });
      }
      if (rows.length < MIN_CROSS_SECTION) return;
      const sorted = rows.map((x) => x.r).sort((a, b) => a - b);
      const lo = sorted[Math.floor(WINSOR * (sorted.length - 1))], hi = sorted[Math.ceil((1 - WINSOR) * (sorted.length - 1))];
      for (const x of rows) x.r = Math.min(hi, Math.max(lo, x.r));
      const average = rows.reduce((a, x) => a + x.r, 0) / rows.length;
      const byBucket = new Map<string, number[]>();
      if (input.bucket === 'decile') {
        const valued = rows.filter((x) => Number.isFinite(x.value)).sort((a, b) => a.value - b.value);
        valued.forEach((x, k) => {
          const d = `D${Math.min(10, Math.floor((k * 10) / valued.length) + 1)}`;
          (byBucket.get(d) ?? byBucket.set(d, []).get(d)!).push(x.r);
        });
      } else {
        for (const x of rows) {
          const b = input.bucket(x.point);
          if (b !== null) (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(x.r);
        }
      }
      for (const [b, rs] of byBucket) {
        (diffs.get(b) ?? diffs.set(b, []).get(b)!).push(rs.reduce((a, v) => a + v, 0) / rs.length - average);
        counts.set(b, (counts.get(b) ?? 0) + rs.length);
      }
    });
    for (const [b, ds] of diffs) {
      out.push({
        horizon: h, bucket: b, months: ds.length, count: counts.get(b) ?? 0,
        meanExcess: mean(ds), tStat: meanTest(ds).t, hitRate: ds.length ? ds.filter((d) => d > 0).length / ds.length : null,
      });
    }
  }
  return out;
}

// ── What the evidence says about the weights ─────────────────────────────────

/**
 * How large a rank IC is at all, as a prior: well-documented factors run at
 * 0.02–0.06 over a month, and 0.10 would be exceptional.
 */
export const IC_PRIOR_SD = 0.05;

export interface WeightSuggestion {
  key:         string;
  current:     number;
  suggested:   number;
  /** Measured mean IC; null when the pillar was not measured at this horizon. */
  ic:          number | null;
  /** The IC shrunk towards zero by its own uncertainty — what the tilt reads. */
  shrunkIc:    number;
  independent: number;
}

/**
 * What a weight is multiplied by for an IC measured at `ic ± se`.
 *
 * The IC is shrunk towards zero by how uncertain it is — `ic × τ² / (τ² + se²)`,
 * the posterior mean under a normal prior of width τ on the true IC — and the
 * weight tilts by `1 + shrunk / τ`. A signal measured at one prior width of
 * skill doubles, one at minus that width drops out, and one measured over a
 * handful of windows barely moves. With no prior width at all (τ = 0) the ICs
 * are indistinguishable from their noise and nothing moves.
 */
export function tiltFor(ic: number, se: number, tau: number): number {
  if (!(tau > 0)) return 1;
  return Math.max(0, 1 + (ic * tau ** 2 / (tau ** 2 + se ** 2)) / tau);
}

/**
 * Whether a set of signals ranks anything at all, taken together: the sum of
 * their squared t-statistics. With no skill anywhere each t is noise and the
 * sum averages `k`, the number of signals; well above `k` says some of them
 * rank, near or below it says the lot is indistinguishable from chance.
 */
export function jointTest(measured: { ic: number; se: number }[]): { sumT2: number; k: number } {
  const usable = measured.filter((m) => m.se > 0);
  return { sumT2: usable.reduce((a, m) => a + (m.ic / m.se) ** 2, 0), k: usable.length };
}

/**
 * How far apart the true ICs of a set of signals are, from their measured ones.
 *
 * Measured ICs scatter by the true spread and by their own noise. Weighting
 * each by its precision, the squared t-statistics sum to `k` plus the true
 * variance times the total precision (`jointTest`), so the variance is what
 * that sum leaves above `k` — the DerSimonian–Laird estimate, centred on no
 * skill. Unweighted, the noisiest signals would decide: a momentum IC that
 * swings twice as wide as the others drowns them. Zero when the sum does not
 * exceed `k`: the differences between the signals are then the size noise
 * makes, and a tilt read off them would be noise. Fewer than three estimate
 * nothing.
 */
export function priorSdFrom(measured: { ic: number; se: number }[]): number {
  const usable = measured.filter((m) => m.se > 0);
  if (usable.length < 3) return 0;
  const { sumT2, k } = jointTest(usable);
  const precision = usable.reduce((a, m) => a + 1 / m.se ** 2, 0);
  const variance = (sumT2 - k) / precision;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/**
 * Pillar weights the evidence argues for, starting from the ones set by judgment.
 *
 * Each pillar's weight is tilted by its measured IC (`tiltFor`, with the
 * generic prior width `IC_PRIOR_SD`) and the result renormalised to the total
 * the weights had before.
 *
 * A suggestion, never applied: the weights are the scoring model, and a model
 * refitted to its own recent returns stops being a test of anything. The live
 * evaluation has months, not years; the backtest fits and checks its own
 * (`backtest/weights.ts`), and a change to the weights is a commit.
 */
export function suggestWeights(
  current: Record<string, number>, ics: IcSummary[], horizon: number, keyOf: (name: string) => string,
): WeightSuggestion[] {
  const rows = Object.entries(current).map(([key, w]) => {
    const r = ics.find((x) => x.key === keyOf(key) && x.horizon === horizon);
    const measured = r?.meanIc != null && r.se != null;
    const shrunkIc = measured ? r.meanIc! * IC_PRIOR_SD ** 2 / (IC_PRIOR_SD ** 2 + r.se! ** 2) : 0;
    return {
      key, current: w, ic: r?.meanIc ?? null, shrunkIc, independent: r?.independent ?? 0,
      tilted: w * (measured ? tiltFor(r.meanIc!, r.se!, IC_PRIOR_SD) : 1),
    };
  });
  const total = rows.reduce((a, r) => a + r.current, 0);
  const tiltedTotal = rows.reduce((a, r) => a + r.tilted, 0);
  return rows.map(({ tilted, ...r }) => ({
    ...r, suggested: tiltedTotal > 0 ? (tilted / tiltedTotal) * total : r.current,
  }));
}
