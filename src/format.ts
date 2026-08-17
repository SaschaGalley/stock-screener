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

/** Currency amount abbreviated to T/B/M/K, in `currency` (default USD). */
export function fmtBig(n: number | null | undefined, currency?: string | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  const c = currencyPrefix(currency);
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${c}${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${c}${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${c}${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3)  return `${c}${(n / 1e3).toFixed(1)}K`;
  return `${c}${n.toFixed(0)}`;
}

/** Plain price with two decimals, in `currency` (default USD). */
export function fmtPrice(n: number | null | undefined, currency?: string | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  return `${currencyPrefix(currency)}${n.toFixed(2)}`;
}
