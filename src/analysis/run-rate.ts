/**
 * Run-rate arithmetic, shared by the peer medians, the valuation models and
 * the web UI.
 *
 * A trailing-twelve-month figure is the sum of four quarters, so it sits one
 * and a half quarters behind the latest one. At a steady year-over-year growth
 * rate g those quarters are Q₀·y^(−k/4) for k = 0…3, with y = 1 + g, which ties
 * the latest quarter annualised to the TTM sum by a fixed factor. That factor
 * turns a peer's TTM multiple into a run-rate one without fetching its
 * quarters. Where we do have the quarters, growing each by its own age does
 * the same job exactly, and divides out the seasonal pattern on the way.
 *
 * Dependency-free on purpose, like `format.ts`: the web app imports it
 * directly across the package boundary.
 */

/**
 * The last four quarters (oldest first), each grown by its own age to the
 * latest quarter's date at `yoyGrowth`, summed. For steady growth that is the
 * latest quarter × 4; with a seasonal pattern every season still appears once,
 * so the pattern averages out instead of hanging on which quarter came last.
 */
export function seasonallyAdjustedRunRate(lastFour: number[], yoyGrowth: number): number | null {
  const y = 1 + yoyGrowth;
  if (lastFour.length !== 4 || !Number.isFinite(y) || y <= 0) return null;
  return lastFour.reduce((sum, revenue, i) => sum + revenue * Math.pow(y, (3 - i) / 4), 0);
}

/** (latest quarter × 4) ÷ TTM for revenue growing steadily at `yoyGrowth` (decimal). */
export function runRateToTrailing(yoyGrowth: number): number | null {
  const y = 1 + yoyGrowth;
  if (!Number.isFinite(y) || y <= 0) return null;
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += Math.pow(y, -k / 4);
  return 4 / sum;
}

/**
 * How far SVR may sit from its seasonally adjusted value before it is worth
 * saying so. Steady growth cannot open a gap — the adjustment accounts for it —
 * so a gap this size means the latest quarter is a seasonal high or low, or
 * carries something one-off such as an acquisition.
 */
export const SEASONAL_GAP_THRESHOLD = 0.10;
