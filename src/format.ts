/**
 * Number formatting shared by the terminal output and the web UI.
 *
 * These three lived twice — once in `analysis/metrics.ts` for markdown reports,
 * once in `web/src/format.ts` for the browser — with bodies that had already
 * started to differ (only one of them knew about thousands). Same numbers, same
 * readers, so: one definition, imported by both.
 *
 * Dependency-free on purpose, like `models.ts` and `symbols.ts` — the web app
 * imports it directly across the package boundary.
 */

/** Fixed-decimal number with an optional suffix. `N/A` for anything unusable. */
export function fmt(n: number | null | undefined, suffix = '', decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  return `${n.toFixed(decimals)}${suffix}`;
}

/** Percent from a FRACTION: 0.145 → "14.5%". */
export function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  return `${(n * 100).toFixed(decimals)}%`;
}

/** Signed percent from a FRACTION: 0.145 → "+14.5%". */
export function fmtSignedPct(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  const v = n * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`;
}

/** Percent from PERCENTAGE POINTS: 14.5 → "+14.5%", em dash when unusable. */
export function fmtPercentPoints(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}

/**
 * Currency symbol for an ISO 4217 code, falling back to the code itself.
 *
 * Everything used to be printed with a hardcoded `$`, so a EUR-quoted stock
 * reported "$17.26" in the report, the prompt and the UI — and the model then
 * wrote dollar figures into a German research note about an Austrian company.
 * Unknown codes get the code plus a space ("CHF 42.00"), which is correct if
 * less pretty than a symbol.
 */
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', CHF: 'CHF ', DKK: 'DKK ',
  SEK: 'SEK ', NOK: 'NOK ', HKD: 'HK$', CAD: 'C$', AUD: 'A$', KRW: '₩', INR: '₹',
  BRL: 'R$', TWD: 'NT$', ILS: '₪', PLN: 'PLN ', GBp: 'p',
};

/**
 * Prefix for a currency code. Defaults to `$` when the code is missing, which
 * keeps every existing call site rendering exactly as before.
 */
export function currencyPrefix(code?: string | null): string {
  if (!code) return '$';
  return CURRENCY_SYMBOL[code] ?? `${code} `;
}

/**
 * Magnitude-abbreviated number with no unit at all: 1.23e9 → "1.23B".
 *
 * For quantities that are not money — share counts, mostly. Those used to be
 * printed as `fmtBig(n).replace('$', '')`, which stops working the moment the
 * prefix is a euro sign: a EUR-quoted stock reported "€1.2B shares short".
 */
export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3)  return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

/** Currency amount abbreviated to T/B/M/K, in `currency` (default USD). */
export function fmtBig(n: number | null | undefined, currency?: string | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  return `${currencyPrefix(currency)}${fmtCount(n)}`;
}

/** Plain price with two decimals, in `currency` (default USD). */
export function fmtPrice(n: number | null | undefined, currency?: string | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  return `${currencyPrefix(currency)}${n.toFixed(2)}`;
}

// ─── The same numbers as the German page writes them ─────────────────────────
//
// The browser is German and wrote "$328.09" beside "−1,7 %": amounts in the
// terminal's notation, percentages in the page's own. These are the page's
// notation for every formatter above — decimal comma, thousands point, the
// currency after the amount, Mio./Mrd./Bio. — under the same contract (same
// arguments, an em dash for anything unusable). The web app imports them
// under the plain names; the terminal and the prompts keep the ones above.

const UNUSABLE_DE = '—';
const isNum = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isFinite(n);

/** 1234.5 → "1.234,50"; the minus is a real minus. */
export function deNumber(n: number, decimals = 2): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).replace('-', '−');
}

/** Currency sign written after a German amount: "328,09 $", "154,34 €", "42,00 CHF". */
export function currencySuffix(code?: string | null): string {
  return currencyPrefix(code).trim();
}

export function fmtDe(n: number | null | undefined, suffix = '', decimals = 2): string {
  return isNum(n) ? `${deNumber(n, decimals)}${suffix}` : UNUSABLE_DE;
}

export function fmtPctDe(n: number | null | undefined, decimals = 1): string {
  return isNum(n) ? `${deNumber(n * 100, decimals)} %` : UNUSABLE_DE;
}

export function fmtSignedPctDe(n: number | null | undefined, decimals = 1): string {
  return isNum(n) ? `${n >= 0 ? '+' : ''}${deNumber(n * 100, decimals)} %` : UNUSABLE_DE;
}

export function fmtPercentPointsDe(n: number | null | undefined, decimals = 1): string {
  return isNum(n) ? `${n >= 0 ? '+' : ''}${deNumber(n, decimals)} %` : UNUSABLE_DE;
}

/** 1.23e9 → "1,23 Mrd." — share counts and other quantities without a unit. */
export function fmtCountDe(n: number | null | undefined): string {
  if (!isNum(n)) return UNUSABLE_DE;
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${deNumber(n / 1e12)} Bio.`;
  if (abs >= 1e9)  return `${deNumber(n / 1e9)} Mrd.`;
  if (abs >= 1e6)  return `${deNumber(n / 1e6)} Mio.`;
  if (abs >= 1e3)  return `${deNumber(n / 1e3, 1)} Tsd.`;
  return deNumber(n, 0);
}

export function fmtBigDe(n: number | null | undefined, currency?: string | null): string {
  return isNum(n) ? `${fmtCountDe(n)} ${currencySuffix(currency)}` : UNUSABLE_DE;
}

export function fmtPriceDe(n: number | null | undefined, currency?: string | null): string {
  return isNum(n) ? `${deNumber(n)} ${currencySuffix(currency)}` : UNUSABLE_DE;
}
