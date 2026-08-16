/**
 * The Postgres connection, once.
 *
 * A single lazily-created pool for the whole process — the CLI, the HTTP server
 * and the nightly scheduler all run in one container and share it. Nothing here
 * knows what a stock is; the domain lives in `store.ts`.
 */

import pg from 'pg';
// Not just for the value: importing this module is what loads `.env`. Reading
// process.env directly here meant `npm run migrate` never saw the file, because
// nothing on that entry point's import path had pulled dotenv in.
import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';

const { Pool, types } = pg;

// node-postgres hands back NUMERIC as a string to avoid silent float rounding.
// Every NUMERIC in this schema is a small money amount (LLM cost in USD) where
// a double is exact enough and a string would break arithmetic at the call
// site, so parse it here rather than in each reader.
types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)));
// BIGINT (int8) — ids fit in a double long before they reach 2^53.
types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10)));

let pool: pg.Pool | null = null;

const NO_URL =
  'DATABASE_URL is not set. The app stores everything in Postgres — add it to .env '
  + '(see .env.example), start one with `docker compose up -d postgres`, or point it '
  + 'at an existing server.';

/** Configuration error, as opposed to a server that is merely not up yet. */
export class MissingDatabaseUrlError extends Error {
  constructor() {
    super(NO_URL);
    this.name = 'MissingDatabaseUrlError';
  }
}

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = getConfig().databaseUrl;
  if (!connectionString) throw new MissingDatabaseUrlError();

  pool = new Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // An idle-client error (server restart, network blip) reaches the pool with
  // no request to attach it to. Without a handler it is an unhandled 'error'
  // event, which takes the process down; the pool discards the client and
  // reconnects on the next query by itself.
  pool.on('error', (e) => logger.warn(`Postgres idle client error: ${e.message}`));

  return pool;
}

/** Run a query. Thin wrapper so call sites never touch the pool directly. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

/** First row, or null. The shape most reads in `store.ts` actually want. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}

/**
 * Run a function inside a transaction on one dedicated client, rolling back on
 * throw. Used where a snapshot and the observations projected from it must land
 * together or not at all.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { /* connection already gone */ });
    throw e;
  } finally {
    client.release();
  }
}

/** Close the pool — for CLI runs and tests, so the process can exit. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/**
 * Wait for the server to accept connections.
 *
 * The app and Postgres start together under compose, and the app usually wins
 * the race. A healthcheck-based `depends_on` handles it there, but a plain
 * `docker compose up` or a local `npm run serve` against a just-started server
 * has no such gate — retrying briefly is cheaper than a crash loop.
 */
export async function waitForDatabase(attempts = 30, delayMs = 1000): Promise<void> {
  // A missing URL is a configuration error, not a server that hasn't finished
  // booting. Retrying it just delays the message by half a minute.
  if (!getConfig().databaseUrl) throw new MissingDatabaseUrlError();

  for (let i = 1; i <= attempts; i++) {
    try {
      await query('SELECT 1');
      return;
    } catch (e) {
      if (i === attempts) throw e;
      if (i === 1) logger.info('Waiting for Postgres…');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
