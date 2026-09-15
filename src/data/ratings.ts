/**
 * Synthetic credit ratings: interest coverage → rating bucket → default spread.
 *
 * A firm's cost of debt is what it would pay to borrow today, not the coupon it
 * locked in years ago. Interest expense ÷ total debt measures the second, and in
 * September 2026 it sat on the risk-free floor for 19 of the 26 stocks with a
 * DCF — a rate only debt issued in cheaper years can carry. So the rate is
 * rebuilt the way Damodaran builds it: coverage says which rating the firm would
 * earn, the bond market says what that rating costs.
 *
 * Coverage thresholds are Damodaran's table for large non-financial service
 * firms (datafile/ratings.html, January 2026), his fifteen notches collapsed
 * onto the seven buckets ICE BofA publishes option-adjusted spreads for on FRED.
 * The spreads are fetched live; `fallbackSpread` is his January 2026 spread for
 * the bucket's namesake notch (A2/A, Ba2/BB, B2/B, Caa/CCC).
 */

export const RATING_BUCKETS = [
  { rating: 'AAA', minCoverage: 8.5,       fredSeries: 'BAMLC0A1CAAA', fallbackSpread: 0.0040 },
  { rating: 'AA',  minCoverage: 6.5,       fredSeries: 'BAMLC0A2CAA',  fallbackSpread: 0.0055 },
  { rating: 'A',   minCoverage: 3.0,       fredSeries: 'BAMLC0A3CA',   fallbackSpread: 0.0078 },
  { rating: 'BBB', minCoverage: 2.5,       fredSeries: 'BAMLC0A4CBBB', fallbackSpread: 0.0111 },
  { rating: 'BB',  minCoverage: 2.0,       fredSeries: 'BAMLH0A1HYBB', fallbackSpread: 0.0184 },
  { rating: 'B',   minCoverage: 1.25,      fredSeries: 'BAMLH0A2HYB',  fallbackSpread: 0.0321 },
  { rating: 'CCC', minCoverage: -Infinity, fredSeries: 'BAMLH0A3HYC',  fallbackSpread: 0.0885 },
] as const;

export type Rating = typeof RATING_BUCKETS[number]['rating'];
export type CreditSpreads = Record<Rating, number>;

export const RATINGS = RATING_BUCKETS.map((b) => b.rating) as readonly Rating[];

export const FALLBACK_SPREADS = Object.fromEntries(
  RATING_BUCKETS.map((b) => [b.rating, b.fallbackSpread]),
) as CreditSpreads;

/**
 * What to assume for a firm that carries debt but reports no interest expense
 * (Apple stopped breaking it out): BBB, the most common rating among US
 * investment-grade issuers — no evidence in either direction.
 */
export const UNRATED: Rating = 'BBB';

/** The bucket a firm with this interest coverage (EBIT ÷ interest expense) would be rated into. */
export function ratingForCoverage(coverage: number): Rating {
  // NaN compares false against every threshold, including −∞; it means no
  // coverage worth the name, which is the bottom bucket.
  return (RATING_BUCKETS.find((b) => coverage >= b.minCoverage) ?? RATING_BUCKETS[RATING_BUCKETS.length - 1]).rating;
}
