/**
 * Raw history: daily prices, analyst actions, insider trades.
 *
 * Kept apart from `store.ts` because these are not snapshots of a payload but
 * append-only records with their own natural keys — a trading day, a rating
 * action, a trade — that grow by upsert rather than by version. See
 * `migrations/010_history.sql` for why each exists.
 */

import { createHash } from 'crypto';

import type { AnalystActionRow, InsiderTransactionRow, PriceBarRow, PriceEventRow } from '../data/yahoo-raw.js';
import { query, queryOne } from './client.js';
import { upsertSymbol } from './store.js';

const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Upsert a ticker's bars. The close is always replaced — after a split Yahoo
 * restates the whole history on the new basis, and mixing bases in one series
 * is the one thing a price table must not do. Open, high, low and volume are
 * kept when the new row lacks them: a long backfill carries closes only, and
 * must not erase the bars the nightly refresh recorded in full.
 */
export async function savePriceBars(ticker: string, bars: PriceBarRow[]): Promise<number> {
  const rows = bars.filter((b) => finite(b.close) !== null && b.close > 0 && /^\d{4}-\d{2}-\d{2}$/.test(b.day));
  if (rows.length === 0) return 0;
  const res = await query(
    `INSERT INTO price_bars (ticker, day, open, high, low, close, adj_close, volume)
     SELECT $1, t.day, t.open, t.high, t.low, t.close, t.adj_close, t.volume
       FROM unnest($2::date[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[])
            AS t(day, open, high, low, close, adj_close, volume)
     ON CONFLICT (ticker, day) DO UPDATE SET
       open       = COALESCE(EXCLUDED.open, price_bars.open),
       high       = COALESCE(EXCLUDED.high, price_bars.high),
       low        = COALESCE(EXCLUDED.low, price_bars.low),
       close      = EXCLUDED.close,
       adj_close  = COALESCE(EXCLUDED.adj_close, price_bars.adj_close),
       volume     = COALESCE(EXCLUDED.volume, price_bars.volume),
       updated_at = now()`,
    [
      ticker.toUpperCase(),
      rows.map((r) => r.day),
      rows.map((r) => finite(r.open)),
      rows.map((r) => finite(r.high)),
      rows.map((r) => finite(r.low)),
      rows.map((r) => r.close),
      rows.map((r) => finite(r.adjClose)),
      rows.map((r) => finite(r.volume)),
    ],
  );
  return res.rowCount ?? 0;
}

export async function savePriceEvents(ticker: string, events: PriceEventRow[]): Promise<void> {
  const rows = events.filter((e) => Number.isFinite(e.value) && e.value > 0);
  if (rows.length === 0) return;
  await query(
    `INSERT INTO price_events (ticker, day, kind, value)
     SELECT $1, t.day, t.kind, t.value FROM unnest($2::date[], $3::text[], $4::float8[]) AS t(day, kind, value)
     ON CONFLICT (ticker, day, kind) DO UPDATE SET value = EXCLUDED.value`,
    [ticker.toUpperCase(), rows.map((r) => r.day), rows.map((r) => r.kind), rows.map((r) => r.value)],
  );
}

/** How many days of a ticker are stored, and the first of them. */
export async function priceCoverage(ticker: string): Promise<{ days: number; first: string | null }> {
  const row = await queryOne<{ days: string; first: Date | null }>(
    'SELECT count(*) AS days, min(day) AS first FROM price_bars WHERE ticker = $1', [ticker.toUpperCase()],
  );
  return { days: Number(row?.days ?? 0), first: row?.first ? row.first.toISOString().slice(0, 10) : null };
}

/** Append rating actions; one already on file is left as first seen. */
export async function saveAnalystActions(symbol: string, rows: AnalystActionRow[]): Promise<void> {
  const valid = rows.filter((r) => r.firm && !Number.isNaN(Date.parse(r.gradedAt)));
  if (valid.length === 0) return;
  const id = await upsertSymbol(symbol);
  // Yahoo writes "no target" as 0; it is an absence, not a target of zero.
  const target = (v: number | null) => (v !== null && Number.isFinite(v) && v > 0 ? v : null);
  await query(
    `INSERT INTO analyst_actions
       (symbol_id, graded_at, firm, action, from_grade, to_grade, price_target_action, price_target, prior_price_target)
     SELECT $1, t.*
       FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::float8[], $9::float8[])
            AS t(graded_at, firm, action, from_grade, to_grade, price_target_action, price_target, prior_price_target)
     ON CONFLICT (symbol_id, graded_at, firm) DO NOTHING`,
    [
      id,
      valid.map((r) => r.gradedAt),
      valid.map((r) => r.firm),
      valid.map((r) => r.action || null),
      valid.map((r) => r.fromGrade || null),
      valid.map((r) => r.toGrade || null),
      valid.map((r) => r.priceTargetAction || null),
      valid.map((r) => target(r.priceTarget)),
      valid.map((r) => target(r.priorPriceTarget)),
    ],
  );
}

/** Append insider trades, identified by the whole row — a filer can trade twice on one day. */
export async function saveInsiderTransactions(symbol: string, rows: InsiderTransactionRow[]): Promise<void> {
  if (rows.length === 0) return;
  const id = await upsertSymbol(symbol);
  const hash = (r: InsiderTransactionRow) => createHash('md5')
    .update(JSON.stringify([r.tradedOn, r.filer, r.relation, r.description, r.shares, r.value, r.ownership]))
    .digest('hex');
  await query(
    `INSERT INTO insider_transactions (symbol_id, row_hash, traded_on, filer, relation, description, shares, value, ownership)
     SELECT $1, t.* FROM unnest($2::text[], $3::date[], $4::text[], $5::text[], $6::text[], $7::float8[], $8::float8[], $9::text[])
            AS t(row_hash, traded_on, filer, relation, description, shares, value, ownership)
     ON CONFLICT (symbol_id, row_hash) DO NOTHING`,
    [
      id,
      rows.map(hash),
      rows.map((r) => r.tradedOn),
      rows.map((r) => r.filer),
      rows.map((r) => r.relation),
      rows.map((r) => r.description),
      rows.map((r) => finite(r.shares)),
      rows.map((r) => finite(r.value)),
      rows.map((r) => r.ownership),
    ],
  );
}
