/**
 * Numeric guards shared across the data, analysis and HTTP layers.
 *
 * These were four private copies with three subtly different spellings of
 * "is this actually a number?" — the kind of helper that is too small to
 * import until the day two copies disagree about NaN.
 */

/** A finite number, or null for anything else (NaN, Infinity, strings, undefined). */
export function toFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Percentage change from `from` to `to`, in percentage points (+14.5 = +14.5%).
 * Null when either side is missing or the base is zero — there is no meaningful
 * "percent above zero".
 */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  const a = toFiniteNumber(from);
  const b = toFiniteNumber(to);
  if (a === null || b === null || a === 0) return null;
  return ((b - a) / a) * 100;
}
