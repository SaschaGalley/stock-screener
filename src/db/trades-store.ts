/**
 * Trades from umsatz, stored. See `migrations/014_trades.sql`.
 *
 * Real holdings: in development read them in aggregate only, never as rows.
 */

import type { Trade, TradeKind } from '../journal.js';
import { query } from './client.js';

export interface TradeRow {
  externalId:   string;
  day:          string;
  isin:         string;
  sourceSymbol: string | null;
  name:         string;
  assetType:    string;
  kind:         TradeKind;
  quantity:     number;
  price:        number;
  currency:     string;
  fee:          number;
}

/**
 * Replace the copy with what the source holds now. A trade it no longer has is
 * marked, not deleted: a journal entry may point at it. Returns how many the
 * source sent and how many were new.
 */
export async function replaceTrades(source: string, rows: TradeRow[]): Promise<{ total: number; added: number }> {
  let added = 0;
  for (const r of rows) {
    const res = await query<{ inserted: boolean }>(
      `INSERT INTO trades (source, external_id, day, isin, symbol, source_symbol, name, asset_type, kind, quantity, price, currency, fee)
       VALUES ($1, $2, $3, $4,
               (SELECT symbol FROM symbols WHERE isin = $4 ORDER BY reference, symbol LIMIT 1),
               $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source, external_id) DO UPDATE SET
         day = EXCLUDED.day, isin = EXCLUDED.isin, symbol = EXCLUDED.symbol, source_symbol = EXCLUDED.source_symbol,
         name = EXCLUDED.name, asset_type = EXCLUDED.asset_type, kind = EXCLUDED.kind, quantity = EXCLUDED.quantity,
         price = EXCLUDED.price, currency = EXCLUDED.currency, fee = EXCLUDED.fee,
         last_seen_at = now(), removed_at = NULL
       RETURNING (xmax = 0) AS inserted`,
      [source, r.externalId, r.day, r.isin, r.sourceSymbol, r.name, r.assetType, r.kind, r.quantity, r.price, r.currency, r.fee],
    );
    if (res.rows[0]?.inserted) added++;
  }
  // By what was sent, not by time: the app's clock and the database's need not agree.
  await query(
    'UPDATE trades SET removed_at = now() WHERE source = $1 AND removed_at IS NULL AND NOT (external_id = ANY($2))',
    [source, rows.map((r) => r.externalId)],
  );
  return { total: rows.length, added };
}

const COLUMNS = `t.id, t.day, t.isin, COALESCE(t.symbol, t.source_symbol) AS symbol, t.name, t.asset_type AS "assetType",
  t.kind, t.quantity, t.price, t.currency`;

/**
 * Purchases and sales nobody has given a reason for yet — neither in an entry
 * nor by dismissing them. Newest first; for one stock when `symbol` is given.
 */
export async function openTrades(symbol?: string): Promise<Trade[]> {
  const res = await query<Trade>(
    `SELECT ${COLUMNS} FROM trades t
      WHERE t.kind IN ('buy', 'sell') AND t.removed_at IS NULL AND t.dismissed_at IS NULL
        AND ($1::text IS NULL OR COALESCE(t.symbol, t.source_symbol) = $1)
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries j WHERE j.deleted_at IS NULL AND t.id = ANY(j.trade_ids)
        )
      ORDER BY t.day DESC, t.id DESC`,
    [symbol?.toUpperCase() ?? null],
  );
  return res.rows;
}

export async function tradesById(ids: number[]): Promise<Trade[]> {
  if (ids.length === 0) return [];
  const res = await query<Trade>(`SELECT ${COLUMNS} FROM trades t WHERE t.id = ANY($1) ORDER BY t.day, t.id`, [ids]);
  return res.rows;
}

/** Needs no reason — an old trade, a test, a transfer. */
export async function dismissTrades(ids: number[]): Promise<number> {
  const res = await query('UPDATE trades SET dismissed_at = now() WHERE id = ANY($1) AND dismissed_at IS NULL', [ids]);
  return res.rowCount ?? 0;
}

/** Every trade the source still has, oldest first — what the positions are summed from. */
export async function allTrades(source: string): Promise<Trade[]> {
  const res = await query<Trade>(
    `SELECT ${COLUMNS} FROM trades t WHERE t.source = $1 AND t.removed_at IS NULL ORDER BY t.day, t.id`,
    [source],
  );
  return res.rows;
}

/** Add the day's prices; a day read again takes the newer reading, since umsatz may correct one. */
export async function savePrices(source: string, rows: { isin: string; day: string; priceEur: number }[]): Promise<void> {
  if (rows.length === 0) return;
  await query(
    `INSERT INTO holding_prices (source, isin, day, price_eur)
     SELECT $1, x.isin, x.day, x.price FROM unnest($2::text[], $3::date[], $4::float8[]) AS x(isin, day, price)
     ON CONFLICT (source, isin, day) DO UPDATE SET price_eur = EXCLUDED.price_eur, fetched_at = now()`,
    [source, rows.map((r) => r.isin.toUpperCase()), rows.map((r) => r.day), rows.map((r) => r.priceEur)],
  );
}

/** Each asset's newest price in euros. */
export async function latestPrices(source: string): Promise<Map<string, { day: string; priceEur: number }>> {
  const res = await query<{ isin: string; day: string; price_eur: number }>(
    `SELECT DISTINCT ON (isin) isin, day, price_eur FROM holding_prices WHERE source = $1 ORDER BY isin, day DESC`,
    [source],
  );
  return new Map(res.rows.map((r) => [r.isin, { day: r.day, priceEur: r.price_eur }]));
}
