/**
 * `pnpm run migrate` — apply pending migrations and sync the metric catalogue,
 * then exit. The server does the same on boot; this exists for running it
 * against a database by hand, before a first backfill or after a schema change.
 */

import { logger } from '../utils/logger.js';
import { closePool, waitForDatabase } from './client.js';
import { migrate } from './migrate.js';
import { buildCatalog, syncCatalog } from './catalog.js';

(async () => {
  await waitForDatabase();
  const applied = await migrate();
  const ids = await syncCatalog();
  logger.success(
    `Schema ${applied.length > 0 ? `updated (${applied.join(', ')})` : 'already current'} · `
    + `${buildCatalog().length} metrics defined, ${ids.size} in the catalogue`,
  );
  await closePool();
})().catch(async (e) => {
  logger.error(`Migration failed: ${(e as Error).message}`);
  await closePool();
  process.exit(1);
});
