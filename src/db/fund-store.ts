/** The funds' holdings as Yahoo sent them (migration 020) and as their issuers list them (022). */

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

/** Keep an issuer's full list of a fund (migration 022); the same list again only moves `last_seen_at`. */
export async function saveFundComposition(isin: string, issuer: string, raw: unknown): Promise<void> {
  const json = JSON.stringify(raw);
  await query(
    `INSERT INTO fund_compositions (isin, issuer, content_hash, data) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (isin, issuer, content_hash) DO UPDATE SET last_seen_at = now()`,
    [isin, issuer, createHash('sha256').update(json).digest(), json],
  );
}

/**
 * The newest list per fund, from whichever issuer — a list over a later answer
 * that no issuer knew the fund, which may only mean one was down — with when
 * the fund was last asked about.
 */
export async function latestFundCompositions(isins: readonly string[]): Promise<Map<string, { issuer: string; raw: unknown; askedAt: Date }>> {
  const res = await query<{ isin: string; issuer: string; data: unknown; asked_at: Date }>(
    `SELECT DISTINCT ON (isin) isin, issuer, data, max(last_seen_at) OVER (PARTITION BY isin) AS asked_at
       FROM fund_compositions WHERE isin = ANY($1)
      ORDER BY isin, issuer = 'none', last_seen_at DESC`,
    [isins],
  );
  return new Map(res.rows.map((r) => [r.isin, { issuer: r.issuer, raw: r.data, askedAt: r.asked_at }]));
}
