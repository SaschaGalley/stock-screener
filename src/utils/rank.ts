/**
 * Where a value stands among others, for the list's rank against the universe.
 */

/** How many of the sorted values are below `v` — or at most `v`, with `orEqual`. */
function countBelow(sorted: readonly number[], v: number, orEqual: boolean): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (orEqual ? sorted[mid] <= v : sorted[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** A score's percentile among others: the share below it, ties counted half. */
export function rankAmong(values: number[]): (v: number | null) => { percentile: number; of: number } | null {
  const sorted = [...values].sort((a, b) => a - b);
  return (v) => {
    if (v === null || sorted.length === 0) return null;
    const below = countBelow(sorted, v, false);
    const ties = countBelow(sorted, v, true) - below;
    return { percentile: (below + ties / 2) / sorted.length, of: sorted.length };
  };
}
