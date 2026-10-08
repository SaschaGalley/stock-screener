/** Yahoo's market lists, kept as fetched (migration 018), and the market briefs (019). */

import { createHash } from 'crypto';

import type { MarketBrief } from '../analysis/market-brief.js';
import { query } from './client.js';

/** Keep one answer of a list; the same content fetched again is not stored twice. */
export async function saveMarketList(list: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data);
  await query(
    `INSERT INTO market_lists (list, content_hash, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (list, content_hash) DO NOTHING`,
    [list, createHash('sha256').update(json).digest(), json],
  );
}

/** Keep a market brief, with the answer it was read from. */
export async function saveMarketBrief(brief: MarketBrief, raw: string): Promise<void> {
  await query(
    `INSERT INTO market_briefs (fetched_at, model, prompt_hash, data, raw, cost_usd) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [brief.fetchedAt, brief.model, brief.promptHash, JSON.stringify(brief), raw, brief.costUsd ?? null],
  );
}

/** The newest brief from `model` to the question `promptHash`, if it is younger than `maxAgeMs`. */
export async function latestMarketBrief(model: string, promptHash: string, maxAgeMs: number): Promise<MarketBrief | null> {
  const res = await query<{ data: MarketBrief }>(
    `SELECT data FROM market_briefs
      WHERE model = $1 AND prompt_hash = $2 AND fetched_at > now() - make_interval(secs => $3)
      ORDER BY fetched_at DESC LIMIT 1`,
    [model, promptHash, maxAgeMs / 1000],
  );
  return res.rows[0]?.data ?? null;
}

/** The newest brief from any model or question, if it is younger than `maxAgeMs`: its calendar for the pages. */
export async function newestMarketBrief(maxAgeMs: number): Promise<MarketBrief | null> {
  const res = await query<{ data: MarketBrief }>(
    `SELECT data FROM market_briefs WHERE fetched_at > now() - make_interval(secs => $1) ORDER BY fetched_at DESC LIMIT 1`,
    [maxAgeMs / 1000],
  );
  return res.rows[0]?.data ?? null;
}
