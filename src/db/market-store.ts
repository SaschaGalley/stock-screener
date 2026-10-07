/** Yahoo's market lists, kept as fetched (migration 018). */

import { createHash } from 'crypto';
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
