/** The funds' holdings as Yahoo sent them (migration 020). */

import { createHash } from 'crypto';

import { query } from './client.js';

/** Keep an answer; the same answer again only moves `last_seen_at`. */
export async function saveFundHoldings(symbol: string, raw: unknown): Promise<void> {
  const json = JSON.stringify(raw);
  await query(
    `INSERT INTO fund_holdings (symbol, content_hash, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (symbol, content_hash) DO UPDATE SET last_seen_at = now()`,
    [symbol, createHash('sha256').update(json).digest(), json],
  );
}

/** The newest answer per fund, with when it was last confirmed. */
export async function latestFundHoldings(symbols: readonly string[]): Promise<Map<string, { raw: unknown; seenAt: Date }>> {
  const res = await query<{ symbol: string; data: unknown; last_seen_at: Date }>(
    `SELECT DISTINCT ON (symbol) symbol, data, last_seen_at FROM fund_holdings
      WHERE symbol = ANY($1) ORDER BY symbol, last_seen_at DESC`,
    [symbols],
  );
  return new Map(res.rows.map((r) => [r.symbol, { raw: r.data, seenAt: r.last_seen_at }]));
}
