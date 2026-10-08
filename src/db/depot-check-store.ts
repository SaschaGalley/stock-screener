/** The depot checks, each kept (migration 021). Private: see CLAUDE.md. */

import type { DepotCheckResult } from '../analysis/depot-check.js';
import { query } from './client.js';

/** Keep a check; the same check again — its manager asked anew — replaces the kept one. */
export async function saveDepotCheck(source: string, result: DepotCheckResult): Promise<void> {
  await query(
    `INSERT INTO depot_checks (source, generated_at, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (source, generated_at) DO UPDATE SET data = EXCLUDED.data`,
    [source, result.generatedAt, JSON.stringify(result)],
  );
}

/** Every check of a source, newest first. */
export async function listDepotChecks(source: string): Promise<{ id: number; result: DepotCheckResult }[]> {
  const res = await query<{ id: string; data: DepotCheckResult }>(
    'SELECT id, data FROM depot_checks WHERE source = $1 ORDER BY generated_at DESC', [source],
  );
  return res.rows.map((r) => ({ id: Number(r.id), result: r.data }));
}
