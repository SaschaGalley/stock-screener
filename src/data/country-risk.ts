/**
 * Damodaran's country risk table: what equity in a country costs over equity in
 * the United States, what its government pays over a risk-free borrower, and
 * the corporate tax rate a mature business there pays at the margin.
 *
 *   https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/ctryprem.html
 *
 * The implied equity risk premium the models discount with is backed out of the
 * S&P 500, so it already *is* the American premium. A company operating in
 * Brazil carries Brazil's premium instead, and the difference between the two
 * countries' premiums is what it adds — Damodaran's own construction, measured
 * against the US rather than against his Aaa "mature market". Before this every
 * stock was discounted as if it were American: Nu Holdings and MercadoLibre
 * carried no country risk at all.
 *
 * Published as an HTML table and refreshed by him a few times a year, so it is
 * fetched like the ERP: once per process and half-day, parsed by column header
 * rather than position, never assumed when it cannot be read.
 */

import { logger } from '../utils/logger.js';

const CTRYPREM_HTML = 'https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/ctryprem.html';

/** The United States, which the implied premium is measured on. */
export const REFERENCE_COUNTRY = 'United States';

export interface CountryRisk {
  /** Sovereign default spread (decimal) from the rating. */
  defaultSpread: number;
  /** Country risk premium over a mature market (decimal). */
  premium: number;
  /** Marginal corporate tax rate (decimal). */
  taxRate: number;
}

export type CountryRiskTable = Map<string, CountryRisk>;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function percent(s: string | undefined): number | null {
  const m = s ? /^(-?\d+(?:\.\d+)?)%$/.exec(s) : null;
  return m ? Number(m[1]) / 100 : null;
}

/** Country names as keys: case and spacing as the table has them, compared loosely. */
export function countryKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Parse the table by its header row. The columns are found by name — he has
 * added columns before, and a positional read would silently start reading the
 * CDS-based premium as the rating-based one.
 */
export function parseCountryRisk(html: string): CountryRiskTable {
  const table: CountryRiskTable = new Map();
  let col: { country: number; spread: number; premium: number; tax: number } | null = null;
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, c]) => cellText(c));
    if (!col) {
      const at = (re: RegExp) => cells.findIndex((c) => re.test(c));
      const header = {
        country: at(/^Country$/i), spread: at(/Default\s+Spread/i),
        premium: at(/^Country Risk\s+Premium/i), tax: at(/Corporate Tax/i),
      };
      if (Object.values(header).every((i) => i >= 0)) col = header;
      continue;
    }
    const name = cells[col.country];
    const defaultSpread = percent(cells[col.spread]);
    const premium = percent(cells[col.premium]);
    const taxRate = percent(cells[col.tax]);
    if (!name || defaultSpread === null || premium === null || taxRate === null) continue;
    table.set(countryKey(name), { defaultSpread, premium, taxRate });
  }
  return table;
}

// ─── Fetching ────────────────────────────────────────────────────────────────

const TTL_MS = 12 * 60 * 60 * 1000;
let cache: { at: number; table: CountryRiskTable } | null = null;
let inFlight: Promise<CountryRiskTable | null> | null = null;

/** The table, or null when it cannot be read — the caller then adds no country risk. */
export async function getCountryRiskTable(): Promise<CountryRiskTable | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.table;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(CTRYPREM_HTML, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const table = parseCountryRisk(await res.text());
      if (!table.has(countryKey(REFERENCE_COUNTRY))) throw new Error('no United States row — layout changed?');
      cache = { at: Date.now(), table };
      return table;
    } catch (e) {
      logger.warn(`Damodaran country risk: ${(e as Error).message}`);
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * What operating from `country` adds to a US-measured cost of capital: its
 * premium and default spread less America's own, and its marginal tax rate.
 * Null when the country is unknown or not in the table — no risk is invented
 * for it, and no discount either.
 */
export function countryRiskFor(
  table: CountryRiskTable, country: string | null | undefined,
): { premium: number; defaultSpread: number; taxRate: number } | null {
  if (!country) return null;
  const row = table.get(countryKey(country));
  const us = table.get(countryKey(REFERENCE_COUNTRY));
  if (!row || !us) return null;
  return {
    premium:       row.premium - us.premium,
    defaultSpread: Math.max(0, row.defaultSpread - us.defaultSpread),
    taxRate:       row.taxRate,
  };
}
