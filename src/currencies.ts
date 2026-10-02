/**
 * Currency codes as Yahoo quotes them, and the unit behind each.
 *
 * Dependency-free on purpose: the data layer reads it to scale a listing's
 * quote fields, the rate layer to pick the right government yield, and neither
 * should drag the other in to ask what "GBp" means.
 */

/**
 * Quote currencies Yahoo prices in a minor unit.
 *
 * London trades in pence (`GBp`), Johannesburg in cents (`ZAc`), Tel Aviv in
 * agorot (`ILA`) — and on those listings the price, the 52-week range and the
 * analyst targets arrive in the minor unit while market cap, trailing EPS, book
 * value and the dividend rate arrive in the major one. Barclays printed a P/B of
 * 95× from a 463.9p price over a £4.87 book value. A closed set of Yahoo's own
 * codes, not something any other field would let us derive.
 */
export const MINOR_UNIT_CURRENCIES: Readonly<Record<string, { major: string; perMajor: number }>> = {
  GBp: { major: 'GBP', perMajor: 100 },
  ZAc: { major: 'ZAR', perMajor: 100 },
  ILA: { major: 'ILS', perMajor: 100 },
};

/** Yahoo's pseudo-ticker for the rate `from → to`: "EURUSD=X" is the dollars one euro buys. */
export function fxTicker(from: string, to: string): string {
  return `${from}${to}=X`;
}

/** The currency a quote currency counts in: GBP for pence, the code itself otherwise. */
export function majorCurrency(code: string | null | undefined): string | null {
  if (!code) return null;
  return MINOR_UNIT_CURRENCIES[code]?.major ?? code.toUpperCase();
}
