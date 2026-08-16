/**
 * Migration runner: numbered .sql files, applied once, in order.
 *
 * Deliberately minimal — no down-migrations, no external tool. Each file runs
 * inside a transaction together with the INSERT that records it, so a failure
 * leaves neither a half-applied schema nor a lie in the ledger.
 */

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { query, tx } from './client.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Apply every migration not yet recorded. Safe to call on every boot; returns
 * the names it applied this time (empty when already up to date).
 */
export async function migrate(): Promise<string[]> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );

  // .sql files ship next to the compiled output as well as the sources; the
  // build copies them (see package.json "build").
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    logger.info(`Applying migration ${file}…`);
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }

  if (ran.length > 0) logger.success(`Applied ${ran.length} migration(s)`);
  else logger.debug('Database schema up to date');
  return ran;
}
