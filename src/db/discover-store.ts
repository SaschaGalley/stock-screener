/**
 * The reference universe, read for the discover page: each stock's profile and
 * newest financials, and the recent verdicts, analyst actions and insider
 * purchases the lists are drawn from. Reference symbols only — the watchlist is
 * what is already being looked at.
 */

import type { AnalystMove, InsiderBuy, VerdictReading } from '../analysis/discover.js';
import { OPEN_MARKET_PURCHASE } from '../analysis/holders.js';
import { query } from './client.js';

export interface UniverseProfile {
  symbol:    string;
  name:      string | null;
  sector:    string | null;
  industry:  string | null;
  website:   string | null;
  currency:  string | null;
  price:     number | null;
  marketCap: number | null;
  /** The statements are old enough to distrust (`fundamentalsStale`). */
  stale:     boolean;
}

/** Every reference symbol with financials: its profile, price and size. */
export async function universeProfiles(): Promise<UniverseProfile[]> {
  const res = await query<{
    symbol: string; company_name: string | null; sector: string | null; industry: string | null;
    website: string | null; currency: string | null; price: number | null; market_cap: number | null; stale: boolean | null;
  }>(
    `SELECT s.symbol, s.company_name, s.sector, s.industry, s.website, s.currency,
            (f.content->>'price')::float8     AS price,
            (f.content->>'marketCap')::float8 AS market_cap,
            (f.content->>'fundamentalsStale')::boolean AS stale
       FROM symbols s
       JOIN LATERAL (
         SELECT content FROM snapshots
          WHERE symbol_id = s.id AND kind = 'financials'
          ORDER BY last_seen_at DESC LIMIT 1
       ) f ON true
      WHERE s.reference`,
  );
  return res.rows.map((r) => ({
    symbol: r.symbol, name: r.company_name, sector: r.sector, industry: r.industry, website: r.website,
    currency: r.currency, price: r.price, marketCap: r.market_cap, stale: r.stale === true,
  }));
}

/** The companies on the watchlist, by the name Yahoo gives them. */
export async function watchlistNames(): Promise<string[]> {
  const res = await query<{ company_name: string }>(
    'SELECT company_name FROM symbols WHERE NOT reference AND company_name IS NOT NULL',
  );
  return res.rows.map((r) => r.company_name);
}

/** The published verdict and score of each reference symbol since `from`, oldest first. */
export async function universeVerdicts(from: Date): Promise<Map<string, VerdictReading[]>> {
  const res = await query<{ symbol: string; observed_at: Date; verdict: string; score: number | null }>(
    `SELECT s.symbol, v.observed_at, v.value_text AS verdict, sc.value AS score
       FROM observations v
       JOIN metrics mv ON mv.id = v.metric_id AND mv.key = 'score.final.verdict'
       JOIN symbols s  ON s.id = v.symbol_id AND s.reference
       LEFT JOIN metrics ms ON ms.key = 'score.final.score'
       LEFT JOIN observations sc
         ON sc.symbol_id = v.symbol_id AND sc.metric_id = ms.id AND sc.observed_at = v.observed_at
      WHERE v.observed_at >= $1 AND v.value_text IS NOT NULL
      ORDER BY s.symbol, v.observed_at`,
    [from],
  );
  const out = new Map<string, VerdictReading[]>();
  for (const r of res.rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({ at: r.observed_at.toISOString(), verdict: r.verdict, score: r.score });
    out.set(r.symbol, list);
  }
  return out;
}

/** Rating and price-target actions on reference symbols since `from`. */
export async function universeAnalystMoves(from: Date): Promise<Map<string, AnalystMove[]>> {
  const res = await query<{ symbol: string; graded_at: Date; firm: string; action: string | null; target: string | null }>(
    `SELECT s.symbol, a.graded_at, a.firm, a.action, a.price_target_action AS target
       FROM analyst_actions a
       JOIN symbols s ON s.id = a.symbol_id AND s.reference
      WHERE a.graded_at >= $1
      ORDER BY s.symbol, a.graded_at`,
    [from],
  );
  const out = new Map<string, AnalystMove[]>();
  for (const r of res.rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({ at: r.graded_at.toISOString(), firm: r.firm, action: r.action, target: r.target });
    out.set(r.symbol, list);
  }
  return out;
}

/**
 * Insiders' purchases on the open market since `from`, by the same wording the
 * financials' insider totals count (`OPEN_MARKET_PURCHASE`): awards, option
 * exercises and conversions are acquisitions too, but nobody paid for them.
 */
export async function universeInsiderBuys(from: string): Promise<Map<string, InsiderBuy[]>> {
  const res = await query<{ symbol: string; traded_on: string; filer: string | null; value: number | null }>(
    `SELECT s.symbol, t.traded_on::text AS traded_on, t.filer, t.value
       FROM insider_transactions t
       JOIN symbols s ON s.id = t.symbol_id AND s.reference
      WHERE t.traded_on >= $1::date AND t.description ILIKE $2
      ORDER BY s.symbol, t.traded_on`,
    [from, `${OPEN_MARKET_PURCHASE}%`],
  );
  const out = new Map<string, InsiderBuy[]>();
  for (const r of res.rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({ day: r.traded_on, filer: r.filer, value: r.value });
    out.set(r.symbol, list);
  }
  return out;
}
