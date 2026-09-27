/**
 * Deterministic sampling for the valuation's uncertainty.
 *
 * The factor score is a pure function of its inputs — the same payload scores
 * the same today and in a re-score of last June — so the DCF's distribution
 * cannot come from `Math.random`. A Halton sequence is a fixed set of points
 * that fills the unit cube more evenly than random draws do: the same answer
 * every run, and a smaller error for the same number of draws.
 */

/** The first primes, one Halton base per dimension. */
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29] as const;

/** Van der Corput radical inverse of `index` in `base`: the index's digits mirrored behind the point. */
function radicalInverse(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let i = index;
  while (i > 0) {
    result += (i % base) * fraction;
    i = Math.floor(i / base);
    fraction /= base;
  }
  return result;
}

/**
 * `count` points in the `dims`-dimensional unit cube. Index 0 is skipped — it is
 * the origin in every base, and a corner is not a sample.
 */
export function haltonPoints(count: number, dims: number): number[][] {
  if (dims > PRIMES.length) throw new Error(`Halton sequence supports up to ${PRIMES.length} dimensions`);
  const out: number[][] = [];
  for (let i = 1; i <= count; i++) {
    out.push(Array.from({ length: dims }, (_, d) => radicalInverse(i, PRIMES[d])));
  }
  return out;
}

/**
 * Inverse of the standard normal CDF — Acklam's rational approximation, good to
 * about 1e-9 over the open unit interval, which is far finer than any input it
 * turns into a scenario.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Linear-interpolated quantile of a sorted sample (Excel PERCENTILE.INC). */
export function quantileSorted(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return lo === hi ? sorted[lo] : sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}
