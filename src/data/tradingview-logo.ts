/**
 * Ticker → TradingView logo.
 *
 * TradingView draws every logo as a filled square with the brand's own
 * background colour, made for a dark chart UI. Logo.dev and the favicon
 * services hand back transparent marks instead, and a black mark (Micron,
 * AMD, Garmin) disappears on our dark rows. TradingView's symbol search maps a
 * ticker to a `logoid`; the SVG lives at a public, unauthenticated URL.
 */

import { logger } from '../utils/logger.js';

const SEARCH_URL = 'https://symbol-search.tradingview.com/symbol_search/v3/';
const LOGO_URL   = 'https://s3-symbol-logo.tradingview.com/';

// Yahoo exchange suffix → the country TradingView files the primary listing under.
const SUFFIX_COUNTRY: Record<string, string> = {
  '':   'US',
  DE: 'DE', F: 'DE', MU: 'DE', SG: 'DE', DU: 'DE', HM: 'DE', BE: 'DE',
  VI: 'AT', SW: 'CH', L: 'GB', IL: 'GB', PA: 'FR', AS: 'NL', BR: 'BE',
  MI: 'IT', MC: 'ES', LS: 'PT', IR: 'IE', ST: 'SE', CO: 'DK', OL: 'NO',
  HE: 'FI', WA: 'PL', PR: 'CZ', AT: 'GR', T: 'JP', HK: 'HK', KS: 'KR',
  KQ: 'KR', TW: 'TW', TWO: 'TW', SS: 'CN', SZ: 'CN', AX: 'AU', NZ: 'NZ',
  TO: 'CA', V: 'CA', NE: 'CA', SA: 'BR', MX: 'MX', NS: 'IN', BO: 'IN',
  SI: 'SG', JK: 'ID', BK: 'TH', KL: 'MY', JO: 'ZA', TA: 'IL',
};

export interface TvSearchHit {
  symbol:              string;
  country?:            string;
  logoid?:             string;
  is_primary_listing?: boolean;
}

/** How TradingView spells a Yahoo ticker, and where its home listing sits. */
export function tradingViewQuery(yahooSymbol: string): { text: string; country: string | null } {
  const upper = yahooSymbol.toUpperCase();
  const dot = upper.lastIndexOf('.');
  const suffix = dot > 0 ? upper.slice(dot + 1) : '';
  let base = dot > 0 && suffix in SUFFIX_COUNTRY ? upper.slice(0, dot) : upper;
  // Yahoo writes share classes with a dash (BRK-B), TradingView with a dot.
  base = base.replace(/-/g, '.');
  // Yahoo pads Hong Kong codes to four digits (0700.HK); TradingView does not.
  if (suffix === 'HK') base = base.replace(/^0+(?=\d)/, '');
  return { text: base, country: SUFFIX_COUNTRY[dot > 0 ? suffix : ''] ?? null };
}

/** The logo of the listing that is this ticker: same symbol, same country,
 *  primary listing first. Nothing when no hit spells the ticker the same way —
 *  a fuzzy match draws some other company's logo, which is worse than none. */
export function pickLogoId(hits: TvSearchHit[], text: string, country: string | null): string | null {
  const exact = hits.filter(h => h.logoid && h.symbol.toUpperCase() === text);
  const local = country ? exact.filter(h => h.country === country) : exact;
  const pool = local.length > 0 ? local : exact;
  return (pool.find(h => h.is_primary_listing) ?? pool[0])?.logoid ?? null;
}

const TTL_MS = 7 * 24 * 3600_000;
const cache = new Map<string, { url: string | null; at: number }>();

/** The TradingView logo URL for a Yahoo ticker, or null when there is none.
 *  Misses are cached as well, so a ticker TradingView lacks costs one lookup a week. */
export async function tradingViewLogoUrl(yahooSymbol: string): Promise<string | null> {
  const key = yahooSymbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.url;

  const { text, country } = tradingViewQuery(key);
  const params = new URLSearchParams({ text, search_type: 'stocks', lang: 'en', domain: 'production' });
  try {
    const res = await fetch(`${SEARCH_URL}?${params}`, {
      headers: { Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { symbols?: TvSearchHit[] };
    const logoid = pickLogoId(body.symbols ?? [], text, country);
    const url = logoid ? `${LOGO_URL}${logoid}.svg` : null;
    cache.set(key, { url, at: Date.now() });
    return url;
  } catch (err) {
    // Not cached: a timeout says nothing about whether the logo exists.
    logger.debug(`TradingView logo lookup failed for ${key}: ${(err as Error).message}`);
    return null;
  }
}
