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
  const row = await queryOne<{ days: string; first: string | null }>(
    'SELECT count(*) AS days, min(day) AS first FROM price_bars WHERE ticker = $1', [ticker.toUpperCase()],
  );
  return { days: Number(row?.days ?? 0), first: row?.first ?? null };
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

/** Upsert a macro series by the date each value is for. A revision replaces the value it revises. */
export async function saveMacroSeries(series: string, rows: { day: string; value: number }[]): Promise<number> {
  const valid = rows.filter((r) => Number.isFinite(r.value) && /^\d{4}-\d{2}-\d{2}$/.test(r.day));
  if (valid.length === 0) return 0;
  const res = await query(
    `INSERT INTO macro_series (series, day, value)
     SELECT $1, t.day, t.value FROM unnest($2::date[], $3::float8[]) AS t(day, value)
     ON CONFLICT (series, day) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()
       WHERE macro_series.value IS DISTINCT FROM EXCLUDED.value`,
    [series, valid.map((r) => r.day), valid.map((r) => r.value)],
  );
  return res.rowCount ?? 0;
}

/** The newest day stored for a series, or null for one never fetched. */
export async function lastMacroDay(series: string): Promise<string | null> {
  const row = await queryOne<{ day: string | null }>('SELECT max(day) AS day FROM macro_series WHERE series = $1', [series]);
  return row?.day ?? null;
}

// ── Reading the archive back ─────────────────────────────────────────────────
// `date` columns arrive as 'YYYY-MM-DD' strings (see the type parser in
// `client.ts`) and are passed through as they are.

/**
 * A ticker's daily closes, oldest first — split-adjusted, on today's basis.
 * Volume is null on bars that came in with a closes-only backfill.
 */
export async function readPriceBars(
  ticker: string, from?: string,
): Promise<{ day: string; close: number; adjClose: number | null; volume: number | null }[]> {
  const res = await query<{ day: string; close: number; adj_close: number | null; volume: number | null }>(
    `SELECT day, close, adj_close, volume FROM price_bars
      WHERE ticker = $1 AND ($2::date IS NULL OR day >= $2) ORDER BY day`,
    [ticker.toUpperCase(), from ?? null],
  );
  return res.rows.map((r) => ({ day: r.day, close: r.close, adjClose: r.adj_close, volume: r.volume === null ? null : Number(r.volume) }));
}

/** Every quote currency a stored symbol trades in. */
export async function quoteCurrencies(): Promise<string[]> {
  const res = await query<{ currency: string }>('SELECT DISTINCT currency FROM symbols WHERE currency IS NOT NULL');
  return res.rows.map((r) => r.currency);
}

/** Closes for several tickers at once, from `from` on — the cross-section's read. */
export async function readPriceBarsMany(
  tickers: string[], from?: string,
): Promise<Map<string, { day: string; close: number; adjClose: number | null }[]>> {
  const res = await query<{ ticker: string; day: string; close: number; adj_close: number | null }>(
    `SELECT ticker, day, close, adj_close FROM price_bars
      WHERE ticker = ANY($1) AND ($2::date IS NULL OR day >= $2) ORDER BY ticker, day`,
    [tickers.map((t) => t.toUpperCase()), from ?? null],
  );
  const out = new Map<string, { day: string; close: number; adjClose: number | null }[]>();
  for (const r of res.rows) {
    const list = out.get(r.ticker) ?? [];
    list.push({ day: r.day, close: r.close, adjClose: r.adj_close });
    out.set(r.ticker, list);
  }
  return out;
}

export async function readPriceEvents(ticker: string): Promise<PriceEventRow[]> {
  const res = await query<{ day: string; kind: 'split' | 'dividend'; value: number }>(
    'SELECT day, kind, value FROM price_events WHERE ticker = $1 ORDER BY day', [ticker.toUpperCase()],
  );
  return res.rows.map((r) => ({ day: r.day, kind: r.kind, value: r.value }));
}

export async function readAnalystActions(symbol: string): Promise<AnalystActionRow[]> {
  const res = await query<{
    graded_at: Date; firm: string; action: string | null; from_grade: string | null; to_grade: string | null;
    price_target_action: string | null; price_target: number | null; prior_price_target: number | null;
  }>(
    `SELECT a.* FROM analyst_actions a JOIN symbols s ON s.id = a.symbol_id
      WHERE s.symbol = $1 ORDER BY a.graded_at`,
    [symbol.toUpperCase()],
  );
  return res.rows.map((r) => ({
    gradedAt: r.graded_at.toISOString(), firm: r.firm, action: r.action, fromGrade: r.from_grade, toGrade: r.to_grade,
    priceTargetAction: r.price_target_action, priceTarget: r.price_target, priorPriceTarget: r.prior_price_target,
  }));
}

export async function readInsiderTransactions(symbol: string): Promise<InsiderTransactionRow[]> {
  const res = await query<{
    traded_on: string | null; filer: string | null; relation: string | null; description: string | null;
    shares: number | null; value: number | null; ownership: string | null;
  }>(
    `SELECT t.traded_on, t.filer, t.relation, t.description, t.shares, t.value, t.ownership
       FROM insider_transactions t JOIN symbols s ON s.id = t.symbol_id
      WHERE s.symbol = $1 ORDER BY t.traded_on DESC NULLS LAST`,
    [symbol.toUpperCase()],
  );
  return res.rows.map((r) => ({
    tradedOn: r.traded_on, filer: r.filer, relation: r.relation, description: r.description,
    shares: r.shares, value: r.value, ownership: r.ownership,
  }));
}

/** One stock's verdict changes, newest first. */
export async function readVerdictChanges(symbol: string): Promise<{ at: string; from: string; to: string; fromScore: number | null; toScore: number | null }[]> {
  const res = await query<{ at: Date; from_verdict: string; to_verdict: string; from_score: number | null; to_score: number | null }>(
    `SELECT v.at, v.from_verdict, v.to_verdict, v.from_score, v.to_score
       FROM verdict_changes v JOIN symbols s ON s.id = v.symbol_id
      WHERE s.symbol = $1 ORDER BY v.at DESC`,
    [symbol.toUpperCase()],
  );
  return res.rows.map((r) => ({ at: r.at.toISOString(), from: r.from_verdict, to: r.to_verdict, fromScore: r.from_score, toScore: r.to_score }));
}
