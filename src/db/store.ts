/**
 * The data store: symbols, snapshots, observations, documents.
 *
 * Replaces the per-symbol JSON cache. Two things changed with the move, and
 * both are the point of it:
 *
 *   1. Writing a payload no longer overwrites the last one. A snapshot is kept
 *      per distinct content, so the record of how a number moved survives.
 *   2. History is a projection, not a schema. `recordObservations` walks the
 *      catalogue and writes every leaf it finds; it never names a field. The
 *      old cache could only grow its 12-field history point by bumping a
 *      version that made its reader discard the entire series.
 *
 * Freshness works exactly as before — a TTL plus a schema version — it just
 * reads `last_seen_at` on the newest snapshot instead of a file mtime.
 */

import { createHash } from 'crypto';
import {
  LLMAnalysis, MarketSignals, NewsItem, ScoreCard, SearchTrace, SectorMedians,
  StockFinancials, TechnicalSignals,
} from '../types.js';
import type { FetchedRates } from '../data/fred.js';
import type { PerplexityContext } from '../data/perplexity.js';
import type { DistillBundle } from '../data/distill.js';
import { CASE_DIRECTIONS, CASE_TITLE, caseLines, readCases } from '../cases.js';
import { logger } from '../utils/logger.js';
import { query, queryOne } from './client.js';
import { buildCatalog, keyedArraysFor, metricIds } from './catalog.js';
import { coerce, LeafKind, readPath } from './walk.js';
import { DEEP_RESEARCH_MODEL, type PerplexityModelId } from '../models.js';

// ── Schema versions ──────────────────────────────────────────────────────────
// Unchanged in meaning from the file cache: a bump makes older payloads
// unreadable for the models. Crucially it no longer touches `observations` —
// history outlives every version bump now.

// 18: adds mostRecentQuarter / lastFiscalYearEnd / fundamentalsStale /
//     dataQualityWarnings, and changes how revenue, EPS, margins, EBITDA, FCF
//     and enterprise value are sourced when Yahoo's market-side modules are
//     stale. Old payloads carry none of the provenance, so they must not be
//     served to the models as if they had been checked.
// 19: adds sharesOutstandingAnnual / prevYear.sharesOutstanding (Piotroski F7)
//     and interestInOperatingCashFlow, which decides the DCF's FCFF add-back.
// 20: adds deferredRevenueShare, which the health pillar needs to read a
//     subscription business's current ratio without its prepayments.
// 21: rebuilds the trailing figures from the quarterly statements — free cash
//     flow as operating cash flow less capex (it was Yahoo's levered FCF),
//     operating income instead of the EBIT line, growth over four quarters
//     instead of one — counts shares across every class, and adds the rest of
//     the equity bridge (minority interest, preferred, non-operating assets,
//     leases), stock compensation and the dilution ratio. `trailingSource`
//     marks a payload built this way; the models rebuild what they can for the
//     ones before it.
export const FINANCIALS_VERSION     = 21;
export const ANALYSIS_VERSION       = 5;
export const NEWS_VERSION           = 1;
export const MARKET_SIGNALS_VERSION = 2;
// Sector medians 2: adds runRatePriceToSales, the benchmark SVR is compared to.
// Sector medians 3: roic is finally populated (it read a Finnhub key that never existed).
// Sector medians 4: negative multiples and the company's own other share classes leave the peer group.
// Sector medians 5: the peers' median beta, the prior a stock's own beta is shrunk towards.
export const SECTOR_MEDIANS_VERSION = 5;

const FINANCIALS_TTL_MS     = 60 * 60 * 1000;
const NEWS_TTL_MS           = 30 * 60 * 1000;
const MARKET_SIGNALS_TTL_MS = 30 * 60 * 1000;
const SECTOR_MEDIANS_TTL_MS = 24 * 60 * 60 * 1000;
const DISTILL_TTL_MS        = 30 * 60 * 1000;

export type SnapshotKind =
  | 'financials' | 'market_signals' | 'metrics'
  | 'sector_medians' | 'news' | 'technical_signals'
  // Derived rather than fetched: rebuilt from the SEC filings and price
  // history, cached for a day (`valuation-history-service.ts`).
  | 'valuation_history'
  // Yahoo's answers as received, beyond what the payload carries
  // (`history-service.ts`): statements, estimates and ratings, holders.
  | 'yahoo_statements' | 'yahoo_analyst' | 'yahoo_holders'
  // Finnhub's /stock/metric: today's ratios, and two decades of them by period.
  | 'finnhub_metric' | 'finnhub_series'
  // Finnhub's insider transactions, each with the day its filing became known.
  | 'finnhub_insider'
  // The score card as published. Observations are re-written when the scoring
  // changes; this is what the reader saw on the day.
  | 'score_card';

// `chart`: an LLM's reading of the price chart (`chart-service.ts`).
export type DocumentKind = 'distill' | 'perplexity' | 'verdict' | 'search_trace' | 'chart';

function hashOf(value: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest();
}

// ── Symbols ──────────────────────────────────────────────────────────────────

/** Identity fields kept on the symbol row rather than as a daily series. */
export interface SymbolProfile {
  companyName?: string | null;
  sector?:      string | null;
  industry?:    string | null;
  isin?:        string | null;
  wkn?:         string | null;
  website?:     string | null;
  currency?:    string | null;
}

const idCache = new Map<string, number>();

/**
 * Ensure the symbol exists and return its id, refreshing the profile when one
 * is supplied. COALESCE on update so a partial profile never blanks a field a
 * richer earlier write had filled in.
 *
 * Only a symbol that does not exist yet costs a value of the id sequence.
 * This used to be one `INSERT … ON CONFLICT DO UPDATE`, and Postgres draws
 * the default id before it finds the conflict, so every write — each snapshot,
 * each news document, each re-scored instant — spent one whether or not a row
 * was created. The sequence was a smallint then. Months of nightly writes, then
 * the reference universe and a re-score of the whole history after every
 * deploy, spent its 32 767 values, and from then on every write for every
 * symbol failed (migration 009). Most callers only want the id, and get it
 * from the cache or one SELECT; a profile is written by an UPDATE, and only a
 * miss inserts.
 */
export async function upsertSymbol(symbol: string, profile: SymbolProfile = {}): Promise<number> {
  const sym = symbol.toUpperCase();
  const fields = [
    profile.companyName, profile.sector, profile.industry, profile.isin, profile.wkn, profile.website, profile.currency,
  ].map((v) => v ?? null);
  if (fields.every((v) => v === null)) {
    const known = await symbolId(sym);
    if (known !== null) return known;
  }
  const row = await queryOne<{ id: number }>(
    `WITH updated AS (
       UPDATE symbols SET
         company_name = COALESCE($2, company_name),
         sector       = COALESCE($3, sector),
         industry     = COALESCE($4, industry),
         isin         = COALESCE($5, isin),
         wkn          = COALESCE($6, wkn),
         website      = COALESCE($7, website),
         currency     = COALESCE($8, currency),
         updated_at   = now()
       WHERE symbol = $1
       RETURNING id
     ), inserted AS (
       INSERT INTO symbols (symbol, company_name, sector, industry, isin, wkn, website, currency)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
       WHERE NOT EXISTS (SELECT 1 FROM updated)
       -- Only a writer racing another to create the same symbol lands here.
       ON CONFLICT (symbol) DO UPDATE SET
         company_name = COALESCE(EXCLUDED.company_name, symbols.company_name),
         sector       = COALESCE(EXCLUDED.sector,       symbols.sector),
         industry     = COALESCE(EXCLUDED.industry,     symbols.industry),
         isin         = COALESCE(EXCLUDED.isin,         symbols.isin),
         wkn          = COALESCE(EXCLUDED.wkn,          symbols.wkn),
         website      = COALESCE(EXCLUDED.website,      symbols.website),
         currency     = COALESCE(EXCLUDED.currency,     symbols.currency),
         updated_at   = now()
       RETURNING id
     )
     SELECT id FROM updated UNION ALL SELECT id FROM inserted`,
    [sym, ...fields],
  );
  idCache.set(sym, row!.id);
  return row!.id;
}

/** Id of a known symbol, or null. Cached — ids never change. */
export async function symbolId(symbol: string): Promise<number | null> {
  const sym = symbol.toUpperCase();
  const hit = idCache.get(sym);
  if (hit !== undefined) return hit;
  const row = await queryOne<{ id: number }>('SELECT id FROM symbols WHERE symbol = $1', [sym]);
  if (row) idCache.set(sym, row.id);
  return row?.id ?? null;
}

/**
 * Which symbols a caller means.
 *
 *   watchlist — the stocks the user added: the list, the nightly analysis, Distill
 *   reference — the universe scored only to calibrate and evaluate the score
 *   all       — both, for everything that reads the score as a population
 */
export type SymbolScope = 'watchlist' | 'reference' | 'all';

const SCOPE_FILTER: Record<SymbolScope, string> = {
  watchlist: 'NOT s.reference',
  reference: 's.reference',
  all:       'TRUE',
};

/**
 * Every symbol the app knows about — the successor to "a directory containing
 * financials.json". Only symbols that actually have financials count, so a
 * half-finished add doesn't appear in the sidebar as an empty row.
 *
 * The watchlist unless asked otherwise: a reference symbol is in the database
 * to be counted, not to be shown.
 */
export async function listSymbols(scope: SymbolScope = 'watchlist'): Promise<string[]> {
  const res = await query<{ symbol: string }>(
    `SELECT s.symbol FROM symbols s
     WHERE ${SCOPE_FILTER[scope]}
       AND EXISTS (SELECT 1 FROM snapshots sn WHERE sn.symbol_id = s.id AND sn.kind = 'financials')
     ORDER BY s.symbol`,
  );
  return res.rows.map((r) => r.symbol);
}

/**
 * Register a symbol as a member of the reference universe.
 *
 * Only ever creates: a symbol that already exists keeps its standing, so a
 * watchlist stock that is also in the index stays on the watchlist.
 */
export async function markReference(symbol: string): Promise<void> {
  // Selected rather than VALUES: `ON CONFLICT DO NOTHING` alone would still
  // draw an id for every member every night (see `upsertSymbol`).
  await query(
    `INSERT INTO symbols (symbol, reference)
     SELECT $1, true WHERE NOT EXISTS (SELECT 1 FROM symbols WHERE symbol = $1)
     ON CONFLICT (symbol) DO NOTHING`,
    [symbol.toUpperCase()],
  );
}

/** The user added a reference symbol: it joins the watchlist with the history it has. */
export async function promoteSymbol(symbol: string): Promise<void> {
  await query(`UPDATE symbols SET reference = false WHERE symbol = $1 AND reference`, [symbol.toUpperCase()]);
}

/** Sector and listing currency per symbol, as the profile last recorded them. */
export async function symbolFacts(
  symbols: string[],
): Promise<Map<string, { sector: string | null; currency: string | null; name: string | null }>> {
  const res = await query<{ symbol: string; sector: string | null; currency: string | null; company_name: string | null }>(
    'SELECT symbol, sector, currency, company_name FROM symbols WHERE symbol = ANY($1)',
    [symbols.map((s) => s.toUpperCase())],
  );
  return new Map(res.rows.map((r) => [r.symbol, { sector: r.sector, currency: r.currency, name: r.company_name }]));
}

/**
 * The newest value of each metric for every symbol in one sector — or in the
 * whole universe when `sector` is null — reference universe included — the cross-section a stock's multiples are read against.
 * Only readings from the last `maxAgeDays`: the universe refreshes a sixth of
 * itself a night, and a multiple from a month ago is a different price.
 */
export async function latestValuesInSector(
  sector: string | null, keys: string[], maxAgeDays: number,
): Promise<{ symbol: string; sector: string | null; industry: string | null; key: string; value: number }[]> {
  const res = await query<{ symbol: string; sector: string | null; industry: string | null; key: string; value: number }>(
    `SELECT DISTINCT ON (o.symbol_id, m.key) s.symbol, s.sector, s.industry, m.key, o.value
       FROM observations o
       JOIN metrics m ON m.id = o.metric_id
       JOIN symbols s ON s.id = o.symbol_id
      WHERE ($1::text IS NULL OR s.sector = $1) AND m.key = ANY($2) AND o.value IS NOT NULL
        AND o.observed_at >= now() - make_interval(days => $3)
      ORDER BY o.symbol_id, m.key, o.observed_at DESC`,
    [sector, keys, maxAgeDays],
  );
  return res.rows;
}

/** Sector and industry as the profile last recorded them. */
export async function symbolGroup(symbol: string): Promise<{ sector: string | null; industry: string | null } | null> {
  return queryOne<{ sector: string | null; industry: string | null }>(
    'SELECT sector, industry FROM symbols WHERE symbol = $1', [symbol.toUpperCase()],
  );
}

/** Whether a symbol is in the database only as a member of the reference universe. */
export async function isReferenceSymbol(symbol: string): Promise<boolean> {
  const row = await queryOne<{ reference: boolean }>('SELECT reference FROM symbols WHERE symbol = $1', [symbol.toUpperCase()]);
  return row?.reference ?? false;
}

/** The published verdict and score at every recorded instant of the last `days`, oldest first. */
export async function recentVerdictPoints(
  symbol: string, days: number,
): Promise<{ at: Date; verdict: string; score: number | null }[]> {
  const series = await readSeries(symbol, ['score.final.verdict', 'score.final.score'], {
    from: new Date(Date.now() - days * 86_400_000),
  });
  const scores = new Map((series.find((x) => x.key === 'score.final.score')?.points ?? []).map((p) => [p.at, p.value]));
  return (series.find((x) => x.key === 'score.final.verdict')?.points ?? [])
    .filter((p) => !!p.text)
    .map((p) => ({ at: new Date(p.at), verdict: p.text as string, score: scores.get(p.at) ?? null }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

export async function recordVerdictChange(
  symbol: string,
  change: { from: string; to: string; fromScore: number | null; toScore: number | null; at: Date },
  source: 'refresh' | 'analysis',
): Promise<void> {
  const id = await upsertSymbol(symbol);
  await query(
    `INSERT INTO verdict_changes (symbol_id, at, from_verdict, to_verdict, from_score, to_score, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, change.at, change.from, change.to, change.fromScore, change.toScore, source],
  );
}

export async function announcedVerdict(symbol: string): Promise<string | null> {
  const row = await queryOne<{ verdict: string }>(
    `SELECT a.verdict FROM verdict_announced a JOIN symbols s ON s.id = a.symbol_id WHERE s.symbol = $1`,
    [symbol.toUpperCase()],
  );
  return row?.verdict ?? null;
}

export async function setAnnouncedVerdict(symbol: string, verdict: string, score: number | null): Promise<void> {
  const id = await upsertSymbol(symbol);
  await query(
    `INSERT INTO verdict_announced (symbol_id, verdict, score, at) VALUES ($1, $2, $3, now())
     ON CONFLICT (symbol_id) DO UPDATE SET verdict = EXCLUDED.verdict, score = EXCLUDED.score, at = now()`,
    [id, verdict, score],
  );
}

export interface VerdictChange {
  symbol:      string;
  companyName: string | null;
  at:          string;
  from:        string;
  to:          string;
  fromScore:   number | null;
  toScore:     number | null;
  source:      'refresh' | 'analysis';
}

/** The newest verdict changes on the watchlist — or of one stock — newest first. */
export async function recentVerdictChanges(limit = 30, symbol?: string): Promise<VerdictChange[]> {
  const res = await query<{
    symbol: string; company_name: string | null; at: Date; from_verdict: string; to_verdict: string;
    from_score: number | null; to_score: number | null; source: 'refresh' | 'analysis';
  }>(
    `SELECT s.symbol, s.company_name, v.at, v.from_verdict, v.to_verdict, v.from_score, v.to_score, v.source
       FROM verdict_changes v JOIN symbols s ON s.id = v.symbol_id
      WHERE NOT s.reference AND ($2::text IS NULL OR s.symbol = $2)
      ORDER BY v.at DESC LIMIT $1`,
    [limit, symbol?.toUpperCase() ?? null],
  );
  return res.rows.map((r) => ({
    symbol: r.symbol, companyName: r.company_name, at: r.at.toISOString(),
    from: r.from_verdict, to: r.to_verdict, fromScore: r.from_score, toScore: r.to_score, source: r.source,
  }));
}

/** How many of `symbols` had their financials confirmed within the last `days`. */
export async function refreshedWithin(symbols: string[], days: number): Promise<number> {
  if (symbols.length === 0) return 0;
  const row = await queryOne<{ n: number }>(
    `SELECT count(DISTINCT s.id)::int AS n
       FROM symbols s
       JOIN snapshots sn ON sn.symbol_id = s.id AND sn.kind = 'financials'
      WHERE s.symbol = ANY($1) AND sn.last_seen_at >= now() - make_interval(days => $2)`,
    [symbols.map((x) => x.toUpperCase()), days],
  );
  return row?.n ?? 0;
}

/** Symbols per scope, for the admin page's counts. */
export async function symbolCounts(): Promise<Record<Exclude<SymbolScope, 'all'>, number>> {
  const row = await queryOne<{ watchlist: number; reference: number }>(
    `SELECT count(*) FILTER (WHERE NOT reference)::int AS watchlist,
            count(*) FILTER (WHERE reference)::int     AS reference
       FROM symbols s
      WHERE EXISTS (SELECT 1 FROM snapshots sn WHERE sn.symbol_id = s.id AND sn.kind = 'financials')`,
  );
  return { watchlist: row?.watchlist ?? 0, reference: row?.reference ?? 0 };
}

/** What the database knows about a company someone might compare a stock with. */
export interface StoredPeer {
  symbol:      string;
  /** Scored in the reference universe only — not on the list. */
  reference:   boolean;
  companyName: string | null;
  industry:    string | null;
  website:     string | null;
  currency:    string | null;
  price:       number | null;
  marketCap:   number | null;
  /** The headline score and its band, as the last refresh recorded them. */
  score:       number | null;
  verdict:     string | null;
}

/**
 * One row per symbol, watchlist and universe alike: the profile, the newest
 * financials' price and size, and the newest recorded score. `where` narrows
 * the symbols; everything else is shared by the two ways a peer is found.
 */
async function storedPeers(where: string, params: unknown[], tail = ''): Promise<StoredPeer[]> {
  const res = await query<{
    symbol: string; reference: boolean; company_name: string | null; industry: string | null;
    website: string | null; currency: string | null; price: number | null; market_cap: number | null;
    score: number | null; verdict: string | null;
  }>(
    `WITH keys AS (
       SELECT (SELECT id FROM metrics WHERE key = 'score.final.score')   AS score_id,
              (SELECT id FROM metrics WHERE key = 'score.final.verdict') AS verdict_id
     )
     SELECT s.symbol, s.reference, s.company_name, s.industry, s.website, s.currency,
            (f.content->>'price')::float8     AS price,
            (f.content->>'marketCap')::float8 AS market_cap,
            sc.value      AS score,
            vd.value_text AS verdict
       FROM symbols s
       CROSS JOIN keys
       JOIN LATERAL (
         SELECT content FROM snapshots
          WHERE symbol_id = s.id AND kind = 'financials'
          ORDER BY last_seen_at DESC LIMIT 1
       ) f ON true
       LEFT JOIN LATERAL (
         SELECT value FROM observations
          WHERE symbol_id = s.id AND metric_id = keys.score_id AND value IS NOT NULL
          ORDER BY observed_at DESC LIMIT 1
       ) sc ON true
       LEFT JOIN LATERAL (
         SELECT value_text FROM observations
          WHERE symbol_id = s.id AND metric_id = keys.verdict_id AND value_text IS NOT NULL
          ORDER BY observed_at DESC LIMIT 1
       ) vd ON true
      WHERE ${where}
      ${tail}`,
    params,
  );
  return res.rows.map((r) => ({
    symbol: r.symbol, reference: r.reference, companyName: r.company_name, industry: r.industry,
    website: r.website, currency: r.currency, price: r.price, marketCap: r.market_cap,
    score: r.score, verdict: r.verdict,
  }));
}

/** The stored facts for each of these symbols that has financials; the rest are simply absent. */
export async function peersBySymbol(symbols: string[]): Promise<Map<string, StoredPeer>> {
  if (symbols.length === 0) return new Map();
  const rows = await storedPeers('s.symbol = ANY($1)', [symbols.map((x) => x.toUpperCase())]);
  return new Map(rows.map((r) => [r.symbol, r]));
}

/**
 * Other companies Yahoo files under the same industry, largest first.
 *
 * Largest by the market cap as quoted, whatever its currency: this only picks
 * which `limit` to return when an industry has more, and nearly the whole
 * universe quotes in dollars or euros.
 */
export async function peersByIndustry(industry: string, exclude: string[], limit: number): Promise<StoredPeer[]> {
  return storedPeers(
    's.industry = $1 AND NOT (s.symbol = ANY($2))',
    [industry, exclude.map((x) => x.toUpperCase())],
    `ORDER BY market_cap DESC NULLS LAST LIMIT ${Math.max(0, Math.floor(limit))}`,
  );
}

/**
 * The next reference symbols to refresh: among `members`, those that are
 * reference symbols (or not yet stored at all), the least recently refreshed
 * first and the never attempted before everything.
 *
 * The rotation needs no state of its own. Whatever a night did not reach is the
 * oldest the next night. A symbol that has never refreshed successfully counts
 * from its first attempt, so a delisted ticker queues behind the rest instead
 * of taking the first slot every night.
 */
export async function referenceRotation(members: string[], limit: number): Promise<string[]> {
  if (members.length === 0 || limit <= 0) return [];
  const res = await query<{ symbol: string }>(
    `SELECT m.symbol
       FROM unnest($1::text[]) AS m(symbol)
       LEFT JOIN symbols s ON s.symbol = m.symbol
       LEFT JOIN LATERAL (
         SELECT max(sn.last_seen_at) AS seen
           FROM snapshots sn
          WHERE sn.symbol_id = s.id AND sn.kind = 'financials'
       ) f ON true
      WHERE s.id IS NULL OR s.reference
      ORDER BY COALESCE(f.seen, s.first_seen_at) ASC NULLS FIRST, m.symbol
      LIMIT $2`,
    [members.map((m) => m.toUpperCase()), limit],
  );
  return res.rows.map((r) => r.symbol);
}

/** Remove a symbol and everything referencing it (all FKs cascade). */
export async function deleteSymbol(symbol: string): Promise<boolean> {
  const sym = symbol.toUpperCase();
  const res = await query('DELETE FROM symbols WHERE symbol = $1', [sym]);
  idCache.delete(sym);
  return (res.rowCount ?? 0) > 0;
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export interface SnapshotRead<T> {
  data:        T;
  capturedAt:  string;
  lastSeenAt:  string;
  schemaVer:   number;
  /** The stored payload predates the current schema version for its kind. */
  stale:       boolean;
}

/**
 * Store a payload.
 *
 * Identical content does not create a second row — it moves `last_seen_at`
 * forward instead. That keeps freshness honest (we did just confirm this data)
 * without inventing a history point for a number that never moved, which is
 * what makes the series readable for slow-moving payloads like peer medians.
 */
export async function saveSnapshot(
  symbol: string,
  kind: SnapshotKind,
  schemaVer: number,
  content: unknown,
  runId?: number | null,
): Promise<void> {
  const id = await upsertSymbol(symbol);
  await query(
    `INSERT INTO snapshots (symbol_id, kind, schema_ver, content, content_hash, run_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (symbol_id, kind, schema_ver, content_hash)
     DO UPDATE SET last_seen_at = now(), run_id = COALESCE(EXCLUDED.run_id, snapshots.run_id)`,
    [id, kind, schemaVer, JSON.stringify(content), hashOf(content), runId ?? null],
  );
}

export interface SnapshotQuery {
  /** Reject payloads written under a different schema version. */
  schemaVer?: number;
  /** Reject payloads not confirmed within this window. */
  maxAgeMs?:  number;
}

/** Newest snapshot of a kind, subject to version and freshness constraints. */
export async function latestSnapshot<T>(
  symbol: string,
  kind: SnapshotKind,
  opts: SnapshotQuery = {},
): Promise<SnapshotRead<T> | null> {
  const id = await symbolId(symbol);
  if (id === null) return null;

  const row = await queryOne<{
    content: T; captured_at: Date; last_seen_at: Date; schema_ver: number;
  }>(
    `SELECT content, captured_at, last_seen_at, schema_ver
       FROM snapshots
      WHERE symbol_id = $1 AND kind = $2
      ORDER BY last_seen_at DESC
      LIMIT 1`,
    [id, kind],
  );
  if (!row) return null;

  const stale = opts.schemaVer !== undefined && row.schema_ver !== opts.schemaVer;
  if (opts.maxAgeMs !== undefined && Date.now() - row.last_seen_at.getTime() > opts.maxAgeMs) {
    logger.debug(`${kind} snapshot for ${symbol} is past its TTL`);
    return null;
  }
  return {
    data:       row.content,
    capturedAt: row.captured_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    schemaVer:  row.schema_ver,
    stale,
  };
}

/** Newest snapshot ignoring TTL and version — for identity fields only. */
export async function latestSnapshotLax<T>(symbol: string, kind: SnapshotKind): Promise<T | null> {
  return (await latestSnapshot<T>(symbol, kind))?.data ?? null;
}

export interface SnapshotMeta {
  capturedAt: string;
  lastSeenAt: string;
  schemaVer:  number;
}

/**
 * Newest snapshot of a kind for every symbol at once.
 *
 * The stock list and the overview each render one row per symbol; asking per
 * symbol would be a query per row, which is exactly the shape the file cache
 * had and the reason the overview walked 35 directories to draw a table.
 *
 * Like every `…ForAll` reader, it covers the watchlist only: these draw what
 * the user sees, and the reference universe is there to be counted.
 */
export async function latestSnapshotForAll<T>(
  kind: SnapshotKind,
): Promise<Map<string, { data: T } & SnapshotMeta>> {
  const res = await query<{
    symbol: string; content: T; captured_at: Date; last_seen_at: Date; schema_ver: number;
  }>(
    `SELECT DISTINCT ON (sn.symbol_id)
            s.symbol, sn.content, sn.captured_at, sn.last_seen_at, sn.schema_ver
       FROM snapshots sn
       JOIN symbols s ON s.id = sn.symbol_id
      WHERE sn.kind = $1 AND NOT s.reference
      ORDER BY sn.symbol_id, sn.last_seen_at DESC`,
    [kind],
  );
  return new Map(res.rows.map((r) => [r.symbol, {
    data:       r.content,
    capturedAt: r.captured_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    schemaVer:  r.schema_ver,
  }]));
}

// ── Typed snapshot wrappers ──────────────────────────────────────────────────
// Same names and meanings the file cache exposed, so call sites only gained an
// `await`.

export async function readFinancials(symbol: string): Promise<StockFinancials | null> {
  const hit = await latestSnapshot<StockFinancials>(symbol, 'financials', {
    schemaVer: FINANCIALS_VERSION, maxAgeMs: FINANCIALS_TTL_MS,
  });
  return hit && !hit.stale ? hit.data : null;
}

/** Financials regardless of age or version — never where numbers matter. */
export async function readFinancialsLax(symbol: string): Promise<StockFinancials | null> {
  return latestSnapshotLax<StockFinancials>(symbol, 'financials');
}

export async function readFinancialsMeta(symbol: string): Promise<SnapshotRead<StockFinancials> | null> {
  return latestSnapshot<StockFinancials>(symbol, 'financials', { schemaVer: FINANCIALS_VERSION });
}

export async function writeFinancials(
  symbol: string, data: StockFinancials, runId?: number | null,
): Promise<void> {
  // The profile columns come along for the ride: they are the one part of a
  // financials payload that belongs to the symbol rather than to the moment.
  await upsertSymbol(symbol, {
    companyName: data.companyName, sector: data.sector, industry: data.industry,
    isin: data.isin, wkn: data.wkn, website: data.website,
    currency: data.tradingCurrency ?? null,
  });
  await saveSnapshot(symbol, 'financials', FINANCIALS_VERSION, data, runId);
}

export async function readNews(symbol: string): Promise<NewsItem[] | null> {
  const hit = await latestSnapshot<NewsItem[]>(symbol, 'news', {
    schemaVer: NEWS_VERSION, maxAgeMs: NEWS_TTL_MS,
  });
  return hit && !hit.stale ? hit.data : null;
}

export async function readNewsLax(symbol: string): Promise<NewsItem[]> {
  return (await latestSnapshotLax<NewsItem[]>(symbol, 'news')) ?? [];
}

export async function writeNews(symbol: string, data: NewsItem[], runId?: number | null): Promise<void> {
  await saveSnapshot(symbol, 'news', NEWS_VERSION, data, runId);
}

export async function readMarketSignals(symbol: string): Promise<MarketSignals | null> {
  const hit = await latestSnapshot<MarketSignals>(symbol, 'market_signals', {
    schemaVer: MARKET_SIGNALS_VERSION, maxAgeMs: MARKET_SIGNALS_TTL_MS,
  });
  return hit && !hit.stale ? hit.data : null;
}

export async function readMarketSignalsMeta(symbol: string): Promise<SnapshotRead<MarketSignals> | null> {
  return latestSnapshot<MarketSignals>(symbol, 'market_signals', { schemaVer: MARKET_SIGNALS_VERSION });
}

export async function writeMarketSignals(
  symbol: string, data: MarketSignals, runId?: number | null,
): Promise<void> {
  await saveSnapshot(symbol, 'market_signals', MARKET_SIGNALS_VERSION, data, runId);
}

export async function readSectorMedians(
  symbol: string, maxAgeMs = SECTOR_MEDIANS_TTL_MS,
): Promise<SectorMedians | null> {
  const hit = await latestSnapshot<SectorMedians>(symbol, 'sector_medians', {
    schemaVer: SECTOR_MEDIANS_VERSION, maxAgeMs,
  });
  return hit && !hit.stale ? hit.data : null;
}

export async function writeSectorMedians(
  symbol: string, data: SectorMedians, runId?: number | null,
): Promise<void> {
  await saveSnapshot(symbol, 'sector_medians', SECTOR_MEDIANS_VERSION, data, runId);
}

// ── Documents ────────────────────────────────────────────────────────────────

export interface DocumentInput {
  symbol:   string;
  kind:     DocumentKind;
  /** Distinguishes concurrent documents of one kind — the analysis flag hash. */
  variant?: string;
  /** Readable text. This is what gets diffed across time. */
  content:  string;
  /** The structured original, when there is one. */
  data?:    unknown;
  model?:   string | null;
  costUsd?: number | null;
  runId?:   number | null;
  /** Schema that produced this payload; 0 when it predates versioning. */
  schemaVer?: number;
}

export interface DocumentRow<D = unknown> {
  id:          number;
  kind:        string;
  variant:     string;
  producedAt:  string;
  lastSeenAt:  string;
  model:       string | null;
  content:     string;
  data:        D | null;
  costUsd:     number | null;
  schemaVer:   number;
}

/**
 * Store a text output, deduplicated by content.
 *
 * Re-fetching an unchanged Perplexity synthesis touches `last_seen_at` and
 * nothing else, so `listDocuments` returns the history of what actually
 * changed rather than one row per nightly run.
 */
export async function saveDocument(doc: DocumentInput): Promise<void> {
  const id = await upsertSymbol(doc.symbol);
  await query(
    `INSERT INTO documents
       (symbol_id, kind, variant, schema_ver, content, data, content_hash, model, cost_usd, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (symbol_id, kind, variant, content_hash)
     DO UPDATE SET last_seen_at = now(), run_id = COALESCE(EXCLUDED.run_id, documents.run_id)`,
    [
      id, doc.kind, doc.variant ?? '', doc.schemaVer ?? 0, doc.content,
      doc.data === undefined ? null : JSON.stringify(doc.data),
      hashOf({ content: doc.content, data: doc.data ?? null }),
      doc.model ?? null, doc.costUsd ?? null, doc.runId ?? null,
    ],
  );
}

function toDocumentRow<D>(r: {
  id: number; kind: string; variant: string; produced_at: Date; last_seen_at: Date;
  model: string | null; content: string; data: D | null; cost_usd: number | null;
  schema_ver: number;
}): DocumentRow<D> {
  return {
    id: r.id, kind: r.kind, variant: r.variant,
    producedAt: r.produced_at.toISOString(), lastSeenAt: r.last_seen_at.toISOString(),
    model: r.model, content: r.content, data: r.data, costUsd: r.cost_usd,
    schemaVer: r.schema_ver,
  };
}

/** Newest document of a kind (and variant, when given). */
export async function latestDocument<D = unknown>(
  symbol: string, kind: DocumentKind, variant?: string,
): Promise<DocumentRow<D> | null> {
  const id = await symbolId(symbol);
  if (id === null) return null;
  const row = await queryOne<never>(
    `SELECT * FROM documents
      WHERE symbol_id = $1 AND kind = $2 AND ($3::text IS NULL OR variant = $3)
      ORDER BY last_seen_at DESC LIMIT 1`,
    [id, kind, variant ?? null],
  );
  return row ? toDocumentRow<D>(row) : null;
}

/**
 * The change history of a document kind, newest first.
 *
 * This is the table the "what shifted since last month?" question runs against:
 * each row is a version that differed from the one before it.
 */
export async function listDocuments<D = unknown>(
  symbol: string,
  kind: DocumentKind,
  opts: { variant?: string; limit?: number; since?: Date } = {},
): Promise<DocumentRow<D>[]> {
  const id = await symbolId(symbol);
  if (id === null) return [];
  const res = await query<never>(
    `SELECT * FROM documents
      WHERE symbol_id = $1 AND kind = $2
        AND ($3::text IS NULL OR variant = $3)
        AND ($4::timestamptz IS NULL OR produced_at >= $4)
      ORDER BY produced_at DESC
      LIMIT $5`,
    [id, kind, opts.variant ?? null, opts.since ?? null, opts.limit ?? 50],
  );
  return res.rows.map((r) => toDocumentRow<D>(r));
}

// ── Typed document wrappers ──────────────────────────────────────────────────

/**
 * The newest brief of the regular kind — every model but deep research — or of
 * deep research alone.
 *
 * The two are kept apart because they are bought apart: the regular brief by
 * every analysis on its cache window, deep research by a click. Read together,
 * a deep report bought on Monday would stand in for Tuesday's nightly brief and
 * then vanish behind Wednesday's, which is the opposite of what was paid for.
 */
async function latestPerplexity(symbol: string, deep: boolean): Promise<DocumentRow<PerplexityContext> | null> {
  const id = await symbolId(symbol);
  if (id === null) return null;
  const row = await queryOne<never>(
    `SELECT * FROM documents
      WHERE symbol_id = $1 AND kind = 'perplexity' AND (variant = $2) = $3
      ORDER BY last_seen_at DESC LIMIT 1`,
    [id, DEEP_RESEARCH_MODEL, deep],
  );
  return row ? toDocumentRow<PerplexityContext>(row) : null;
}

function within(doc: DocumentRow<PerplexityContext> | null, maxAgeMs: number): PerplexityContext | null {
  if (!doc) return null;
  return Date.now() - new Date(doc.lastSeenAt).getTime() > maxAgeMs ? null : doc.data;
}

/**
 * `maxAgeMs` is a setting, not a constant — see `perplexity-service.ts`.
 * Asking for deep research as the model reads deep research; any other model
 * reads the regular brief, whichever of them wrote it.
 */
export async function readPerplexity(
  symbol: string, maxAgeMs: number, model?: PerplexityModelId,
): Promise<PerplexityContext | null> {
  return within(await latestPerplexity(symbol, model === DEEP_RESEARCH_MODEL), maxAgeMs);
}

export async function readPerplexityLax(symbol: string): Promise<PerplexityContext | null> {
  return (await latestPerplexity(symbol, false))?.data ?? null;
}

/** The deep research report, while it is inside its own, longer window. */
export async function readDeepResearch(symbol: string, maxAgeMs: number): Promise<PerplexityContext | null> {
  return within(await latestPerplexity(symbol, true), maxAgeMs);
}

export async function readDeepResearchLax(symbol: string): Promise<PerplexityContext | null> {
  return (await latestPerplexity(symbol, true))?.data ?? null;
}

export async function writePerplexity(
  symbol: string, data: PerplexityContext, runId?: number | null,
): Promise<void> {
  await saveDocument({
    symbol, kind: 'perplexity', variant: data.model,
    content: data.synthesis, data, model: data.model, runId,
  });
}

export async function readDistill(symbol: string): Promise<DistillBundle | null> {
  const doc = await latestDocument<DistillBundle>(symbol, 'distill');
  if (!doc) return null;
  if (Date.now() - new Date(doc.lastSeenAt).getTime() > DISTILL_TTL_MS) return null;
  return doc.data;
}

export async function readDistillLax(symbol: string): Promise<DistillBundle | null> {
  return (await latestDocument<DistillBundle>(symbol, 'distill'))?.data ?? null;
}

export async function writeDistill(
  symbol: string, data: DistillBundle, runId?: number | null,
): Promise<void> {
  // `content` is the dedup key, so it has to be everything the prompt will
  // see. Keyed on the briefing alone, a day where only the sector dossiers
  // moved would look like no change at all and never be stored.
  const prose = [
    data.company?.content,
    ...(data.sectors ?? []).map((s) => s.content),
    data.briefing?.body,
  ].filter((p): p is string => !!p?.trim()).join('\n\n');

  await saveDocument({
    symbol, kind: 'distill',
    variant: data.briefing?.briefingTypeId ?? '',
    content: prose,
    data,
    model:   data.briefing?.model ?? null,
    costUsd: data.briefing?.costUsd ?? null,
    runId,
  });
}

// ── LLM analyses ─────────────────────────────────────────────────────────────
// Stored as documents keyed by the flag hash. The prose goes in `content` so it
// can be compared across runs; the structured verdict rides along in `data`.

export interface AnalysisFlagsKey {
  model:  string;
  search: string;
  pplx:   PerplexityModelId | null;
}

export function analysisHash(flags: AnalysisFlagsKey): string {
  const s = `${flags.model}|${flags.search}|${flags.pplx ?? 'none'}`;
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export interface CachedAnalysisEntry {
  flags:       AnalysisFlagsKey;
  hash:        string;
  llmAnalysis: LLMAnalysis;
  generatedAt: string;
  searches?:   SearchTrace;
  /**
   * How the headline score was arrived at: the deterministic pillars, the
   * narrative half, and the blend of the two.
   *
   * Optional rather than required, and the schema version is deliberately not
   * bumped for it. Every verdict written before the factor score existed is
   * still a real verdict at a real date, and the series it contributed to is
   * the history the new score is meant to be comparable against — hiding those
   * rows behind a version check would throw away the only baseline there is.
   */
  scoreCard?:  ScoreCard;
}

export interface AnalysisManifestEntry {
  hash:        string;
  flags:       AnalysisFlagsKey;
  generatedAt: string;
  ageMinutes:  number;
}

/**
 * The verdict rendered as the text a reader (or another model) would compare.
 *
 * Tolerant of shape on purpose: schema v3 stored the cases as prose, v4 as flat
 * lists, and since 2 October each side is in sections. Those older verdicts are
 * exactly the history worth keeping, so the text goes through `readCases`
 * rather than assuming today's shape.
 */
export function verdictText(a: LLMAnalysis): string {
  const cases = readCases(a);
  return [
    a.thesis ?? '',
    '',
    `Empfehlung: ${a.recommendation} · Score ${a.score}/10 · Fair Value ${a.fairValueEstimate}`,
    ...CASE_DIRECTIONS.flatMap((d) => [
      '', `${CASE_TITLE[d]}:`,
      ...caseLines(cases[d], d, { bullet: '- ', heading: (label) => `${label}:` }),
    ]),
    ...(cases.undirected.length ? ['', 'Was das Urteil ändern würde:', ...cases.undirected.map((w) => `- ${w}`)] : []),
  ].join('\n');
}

/** Search-trace rendering, shared with the backfill for the same reason. */
export function searchTraceText(trace: SearchTrace): string {
  return trace.providers
    .flatMap((p) => [`## ${p.provider}`, ...p.queries.map((q) => `- ${q}`)])
    .join('\n');
}

/**
 * The newest verdict for a flag combination, current schema only.
 *
 * Older-schema verdicts stay in `documents` — they are real history and the
 * document endpoints serve them — but the app must not hand one to a UI that
 * expects today's shape, which is exactly what the file cache's version check
 * used to guarantee.
 */
export async function readAnalysis(
  symbol: string, flags: AnalysisFlagsKey,
): Promise<CachedAnalysisEntry | null> {
  const id = await symbolId(symbol);
  if (id === null) return null;
  const row = await queryOne<{ data: CachedAnalysisEntry }>(
    `SELECT data FROM documents
      WHERE symbol_id = $1 AND kind = 'verdict' AND variant = $2 AND schema_ver = $3
      ORDER BY produced_at DESC LIMIT 1`,
    [id, analysisHash(flags), ANALYSIS_VERSION],
  );
  return row?.data ?? null;
}

export async function writeAnalysis(
  symbol: string,
  flags: AnalysisFlagsKey,
  llmAnalysis: LLMAnalysis,
  searches?: SearchTrace,
  runId?: number | null,
  scoreCard?: ScoreCard,
): Promise<void> {
  const hash = analysisHash(flags);
  const entry: CachedAnalysisEntry = {
    flags, hash, llmAnalysis,
    generatedAt: new Date().toISOString(),
    ...(searches && searches.providers.length > 0 ? { searches } : {}),
    ...(scoreCard ? { scoreCard } : {}),
  };
  await saveDocument({
    symbol, kind: 'verdict', variant: hash, schemaVer: ANALYSIS_VERSION,
    content: verdictText(llmAnalysis), data: entry,
    model: flags.model, runId,
  });
  if (searches && searches.providers.length > 0) {
    await saveDocument({
      symbol, kind: 'search_trace', variant: hash, schemaVer: ANALYSIS_VERSION,
      content: searchTraceText(searches), data: searches, model: flags.model, runId,
    });
  }
}

/** One entry per flag combination, newest verdict for each. */
export async function listAnalyses(symbol: string): Promise<AnalysisManifestEntry[]> {
  const id = await symbolId(symbol);
  if (id === null) return [];
  const res = await query<{ data: CachedAnalysisEntry; produced_at: Date }>(
    `SELECT DISTINCT ON (variant) data, produced_at
       FROM documents
      WHERE symbol_id = $1 AND kind = 'verdict' AND schema_ver = $2
      ORDER BY variant, produced_at DESC`,
    [id, ANALYSIS_VERSION],
  );
  return res.rows
    .filter((r) => r.data?.flags)
    .map((r) => ({
      hash:        r.data.hash,
      flags:       r.data.flags,
      generatedAt: r.data.generatedAt ?? r.produced_at.toISOString(),
      ageMinutes:  Math.round((Date.now() - r.produced_at.getTime()) / 60000),
    }));
}

/**
 * Newest verdict per flag combination, for every symbol at once.
 *
 * Feeds the sidebar's consensus band and the overview's headline verdict in one
 * query instead of one per stock per combination — the old cache read every
 * `analyses/<hash>.json` of every symbol to draw a single column.
 */
export async function latestVerdictsForAll(): Promise<Map<string, CachedAnalysisEntry[]>> {
  const res = await query<{ symbol: string; data: CachedAnalysisEntry; produced_at: Date }>(
    `SELECT DISTINCT ON (d.symbol_id, d.variant) s.symbol, d.data, d.produced_at
       FROM documents d
       JOIN symbols s ON s.id = d.symbol_id
      WHERE d.kind = 'verdict' AND d.schema_ver = $1 AND NOT s.reference
      ORDER BY d.symbol_id, d.variant, d.produced_at DESC`,
    [ANALYSIS_VERSION],
  );
  const out = new Map<string, CachedAnalysisEntry[]>();
  for (const r of res.rows) {
    if (!r.data?.llmAnalysis) continue;
    const list = out.get(r.symbol) ?? [];
    list.push({ ...r.data, generatedAt: r.data.generatedAt ?? r.produced_at.toISOString() });
    out.set(r.symbol, list);
  }
  return out;
}

/** Drop every stored verdict for one flag combination. */
export async function deleteAnalysis(symbol: string, hash: string): Promise<boolean> {
  const id = await symbolId(symbol);
  if (id === null) return false;
  const res = await query(
    `DELETE FROM documents
      WHERE symbol_id = $1 AND kind IN ('verdict', 'search_trace') AND variant = $2`,
    [id, hash],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Observations ─────────────────────────────────────────────────────────────

interface CatalogEntry { key: string; path: string; kind: LeafKind }

let byDomain: Map<string, CatalogEntry[]> | null = null;

/** Catalogue grouped by domain, with the path back to the payload leaf. */
function catalogByDomain(): Map<string, CatalogEntry[]> {
  if (byDomain) return byDomain;
  byDomain = new Map();
  for (const m of buildCatalog()) {
    const list = byDomain.get(m.domain) ?? [];
    list.push({ key: m.key, path: m.key.slice(m.domain.length + 1), kind: m.valueKind });
    byDomain.set(m.domain, list);
  }
  return byDomain;
}

/** One payload to project: which domain it belongs to, and the value itself. */
export interface ObservationSource {
  domain:  string;
  payload: unknown;
}

interface PendingRow { metricId: number; value: number | null; valueText: string | null }

function projectRows(sources: ObservationSource[], ids: Map<string, number>): PendingRow[] {
  const rows: PendingRow[] = [];
  for (const source of sources) {
    if (source.payload === null || source.payload === undefined) continue;
    const entries = catalogByDomain().get(source.domain) ?? [];
    const keyed = keyedArraysFor(source.domain);
    for (const entry of entries) {
      const id = ids.get(entry.key);
      if (id === undefined) continue;
      const observed = coerce(readPath(source.payload, entry.path, keyed), entry.kind);
      if (!observed) continue;
      rows.push({ metricId: id, value: observed.value, valueText: observed.valueText });
    }
  }
  return rows;
}

/**
 * Project payloads into the observation series.
 *
 * The only writer of history, and it names no field: whatever the catalogue
 * knows about and the payload carries gets recorded. Called from the refresh
 * and analysis paths only — a read must never write a data point, or browsing
 * the UI would forge history.
 */
export async function recordObservations(
  symbol: string,
  sources: ObservationSource[],
  observedAt: Date = new Date(),
  runId?: number | null,
): Promise<number> {
  const ids = await metricIds();
  const rows = projectRows(sources, ids);
  if (rows.length === 0) return 0;

  const id = await upsertSymbol(symbol);
  await query(
    `INSERT INTO observations (symbol_id, metric_id, observed_at, value, value_text, run_id)
     SELECT $1, m, $3, v, t, $6
       FROM unnest($2::smallint[], $4::double precision[], $5::text[]) AS u(m, v, t)
     ON CONFLICT (symbol_id, metric_id, observed_at)
     DO UPDATE SET value = EXCLUDED.value, value_text = EXCLUDED.value_text`,
    [
      id,
      rows.map((r) => r.metricId),
      observedAt,
      rows.map((r) => r.value),
      rows.map((r) => r.valueText),
      runId ?? null,
    ],
  );
  logger.debug(`Recorded ${rows.length} observations for ${symbol}`);
  return rows.length;
}

/** Global series (VIX, curve, spreads, rates) — stored once, not per symbol. */
export async function recordMacro(
  payload: unknown,
  observedAt: Date = new Date(),
  runId?: number | null,
): Promise<number> {
  const ids = await metricIds();
  const rows = projectRows([{ domain: 'macro', payload }], ids);
  if (rows.length === 0) return 0;
  await query(
    `INSERT INTO macro_observations (metric_id, observed_at, value, value_text, run_id)
     SELECT m, $2, v, t, $5
       FROM unnest($1::smallint[], $3::double precision[], $4::text[]) AS u(m, v, t)
     ON CONFLICT (metric_id, observed_at)
     DO UPDATE SET value = EXCLUDED.value, value_text = EXCLUDED.value_text`,
    [
      rows.map((r) => r.metricId), observedAt,
      rows.map((r) => r.value), rows.map((r) => r.valueText), runId ?? null,
    ],
  );
  return rows.length;
}

// ── Reading series back ──────────────────────────────────────────────────────

export interface SeriesPoint { at: string; value: number | null; text: string | null }
export interface Series {
  key:   string;
  label: string;
  unit:  string | null;
  points: SeriesPoint[];
}

/**
 * Series for a set of metric keys.
 *
 * Keys are matched exactly; the catalogue is what makes them discoverable, so
 * the UI can offer a picker instead of hard-coding which numbers are chartable.
 */
export async function readSeries(
  symbol: string,
  keys: string[],
  opts: { from?: Date; to?: Date } = {},
): Promise<Series[]> {
  const id = await symbolId(symbol);
  if (id === null || keys.length === 0) return [];

  const res = await query<{
    key: string; label: string; unit: string | null;
    observed_at: Date; value: number | null; value_text: string | null;
  }>(
    `SELECT m.key, m.label, m.unit, o.observed_at, o.value, o.value_text
       FROM observations o
       JOIN metrics m ON m.id = o.metric_id
      WHERE o.symbol_id = $1
        AND m.key = ANY($2::text[])
        AND ($3::timestamptz IS NULL OR o.observed_at >= $3)
        AND ($4::timestamptz IS NULL OR o.observed_at <= $4)
      ORDER BY m.key, o.observed_at`,
    [id, keys, opts.from ?? null, opts.to ?? null],
  );

  const out = new Map<string, Series>();
  for (const r of res.rows) {
    let series = out.get(r.key);
    if (!series) {
      series = { key: r.key, label: r.label, unit: r.unit, points: [] };
      out.set(r.key, series);
    }
    series.points.push({
      at: r.observed_at.toISOString(), value: r.value, text: r.value_text,
    });
  }
  // Preserve the caller's ordering; a chart legend should follow the request.
  return keys.map((k) => out.get(k)).filter((s): s is Series => s !== undefined);
}

/** The same series for every symbol that has them, in one query — a cross-section's read. */
export async function readSeriesForAll(keys: string[]): Promise<Map<string, Series[]>> {
  if (keys.length === 0) return new Map();
  const res = await query<{
    symbol: string; key: string; label: string; unit: string | null;
    observed_at: Date; value: number | null; value_text: string | null;
  }>(
    `SELECT s.symbol, m.key, m.label, m.unit, o.observed_at, o.value, o.value_text
       FROM observations o
       JOIN metrics m ON m.id = o.metric_id
       JOIN symbols s ON s.id = o.symbol_id
      WHERE m.key = ANY($1::text[])
      ORDER BY s.symbol, m.key, o.observed_at`,
    [keys],
  );
  const out = new Map<string, Series[]>();
  for (const r of res.rows) {
    const list = out.get(r.symbol) ?? [];
    let series = list.find((x) => x.key === r.key);
    if (!series) {
      series = { key: r.key, label: r.label, unit: r.unit, points: [] };
      list.push(series);
      out.set(r.symbol, list);
    }
    series.points.push({ at: r.observed_at.toISOString(), value: r.value, text: r.value_text });
  }
  return out;
}

/**
 * Newest value of one metric for every symbol at once.
 *
 * The overview renders one row per stock; asking per symbol would be a query
 * per row. DISTINCT ON gives the whole column in a single pass.
 */
export async function latestValueForAll(key: string): Promise<Map<string, number>> {
  const res = await query<{ symbol: string; value: number }>(
    `SELECT DISTINCT ON (o.symbol_id) s.symbol, o.value
       FROM observations o
       JOIN metrics m ON m.id = o.metric_id
       JOIN symbols s ON s.id = o.symbol_id
      WHERE m.key = $1 AND o.value IS NOT NULL AND NOT s.reference
      ORDER BY o.symbol_id, o.observed_at DESC`,
    [key],
  );
  return new Map(res.rows.map((r) => [r.symbol, r.value]));
}

/** Full series of one metric for every symbol — the overview's sparklines. */
export async function seriesForAll(
  key: string, opts: { since?: Date } = {},
): Promise<Map<string, SeriesPoint[]>> {
  const res = await query<{ symbol: string; observed_at: Date; value: number | null; value_text: string | null }>(
    `SELECT s.symbol, o.observed_at, o.value, o.value_text
       FROM observations o
       JOIN metrics m ON m.id = o.metric_id
       JOIN symbols s ON s.id = o.symbol_id
      WHERE m.key = $1 AND ($2::timestamptz IS NULL OR o.observed_at >= $2) AND NOT s.reference
      ORDER BY s.symbol, o.observed_at`,
    [key, opts.since ?? null],
  );
  const out = new Map<string, SeriesPoint[]>();
  for (const r of res.rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({ at: r.observed_at.toISOString(), value: r.value, text: r.value_text });
    out.set(r.symbol, list);
  }
  return out;
}

/** The catalogue as the UI sees it — the metric picker's data source. */
export async function listMetrics(domain?: string): Promise<{
  key: string; domain: string; label: string; unit: string | null;
  valueKind: string; description: string | null;
}[]> {
  const res = await query<{
    key: string; domain: string; label: string; unit: string | null;
    value_kind: string; description: string | null;
  }>(
    `SELECT key, domain, label, unit, value_kind, description
       FROM metrics WHERE ($1::text IS NULL OR domain = $1)
      ORDER BY domain, key`,
    [domain ?? null],
  );
  return res.rows.map((r) => ({
    key: r.key, domain: r.domain, label: r.label, unit: r.unit,
    valueKind: r.value_kind, description: r.description,
  }));
}

// ── Fiscal periods ───────────────────────────────────────────────────────────

interface FiscalRow { periodType: 'annual' | 'quarter' | 'estimate'; periodEnd: string; key: string; value: number }

/** Fiscal-year end dates are stored as a date; the source only gives a year. */
function yearEnd(year: number): string { return `${year}-12-31`; }

/**
 * Pull the reported-period series out of a financials payload.
 *
 * These arrays are indexed by fiscal period, not by the day we read them, so
 * they get their own table. Recording `observed_at` alongside means a
 * restatement shows up as a second row for the same period rather than
 * silently replacing the first.
 */
function fiscalRowsFrom(f: StockFinancials): FiscalRow[] {
  const rows: FiscalRow[] = [];
  const push = (
    periodType: FiscalRow['periodType'], periodEnd: string | null, key: string, value: unknown,
  ) => {
    if (!periodEnd || typeof value !== 'number' || !Number.isFinite(value)) return;
    rows.push({ periodType, periodEnd, key, value });
  };

  for (const [metric, series] of Object.entries(f.fundamentalsHistory ?? {})) {
    for (const point of series as { year: number; value: number }[]) {
      push('annual', yearEnd(point.year), metric, point.value);
    }
  }
  for (const q of f.quarterlyRevenues ?? []) push('quarter', q.endDate, 'revenue', q.revenue);
  for (const s of f.earningsSurprises ?? []) {
    // The quarter's end date since 2 October 2026. Before that only Yahoo's
    // relative label ("-1q") was kept, which places nothing on a calendar, so
    // those entries are skipped rather than guessed.
    const end = s.endDate ?? quarterLabelToDate(s.quarter);
    push('quarter', end, 'epsEstimate', s.epsEstimate);
    push('quarter', end, 'epsActual',   s.epsActual);
    push('quarter', end, 'surprisePct', s.surprisePct);
  }
  for (const e of f.earningsEstimates ?? []) {
    push('estimate', e.endDate, 'epsEstimate',     e.epsEstimate);
    push('estimate', e.endDate, 'epsLow',          e.epsLow);
    push('estimate', e.endDate, 'epsHigh',         e.epsHigh);
    push('estimate', e.endDate, 'epsGrowth',       e.epsGrowth);
    push('estimate', e.endDate, 'revenueEstimate', e.revenueEstimate);
    push('estimate', e.endDate, 'revenueGrowth',   e.revenueGrowth);
    push('estimate', e.endDate, 'numberOfAnalysts', e.numberOfAnalysts);
  }
  return rows;
}

/** "3Q2024" → the calendar quarter end. Null when the label is unrecognised. */
function quarterLabelToDate(label: string): string | null {
  const m = /^([1-4])Q(\d{4})$/.exec(label.trim());
  if (!m) return null;
  const ends = ['03-31', '06-30', '09-30', '12-31'];
  return `${m[2]}-${ends[Number(m[1]) - 1]}`;
}

export async function recordFundamentals(
  symbol: string, financials: StockFinancials, observedAt: Date = new Date(),
): Promise<number> {
  const ids = await metricIds();
  const rows = fiscalRowsFrom(financials)
    .map((r) => ({ ...r, metricId: ids.get(`fundamentals.${r.key}`) }))
    .filter((r): r is FiscalRow & { metricId: number } => r.metricId !== undefined);
  if (rows.length === 0) return 0;

  const id = await upsertSymbol(symbol);
  await query(
    `INSERT INTO fundamental_periods (symbol_id, period_type, period_end, metric_id, value, observed_at)
     SELECT $1, pt, pe::date, m, v, $6
       FROM unnest($2::text[], $3::text[], $4::smallint[], $5::double precision[]) AS u(pt, pe, m, v)
     ON CONFLICT (symbol_id, period_type, period_end, metric_id, observed_at) DO NOTHING`,
    [
      id,
      rows.map((r) => r.periodType), rows.map((r) => r.periodEnd),
      rows.map((r) => r.metricId), rows.map((r) => r.value),
      observedAt,
    ],
  );
  return rows.length;
}

/**
 * Reported values per period, newest observation of each.
 *
 * Restatements are collapsed here — a caller that wants to see them asks for
 * the full table. This is the shape the fundamentals chart wants.
 */
export async function readFundamentals(
  symbol: string, periodType: 'annual' | 'quarter' | 'estimate',
): Promise<{ periodEnd: string; key: string; value: number; observedAt: string; firstSeenAt: string }[]> {
  const id = await symbolId(symbol);
  if (id === null) return [];
  const res = await query<{
    period_end: string; key: string; value: number; observed_at: Date; first_seen: Date;
  }>(
    `SELECT DISTINCT ON (fp.period_end, fp.metric_id)
            fp.period_end, m.key, fp.value, fp.observed_at,
            MIN(fp.observed_at) OVER (PARTITION BY fp.period_end, fp.metric_id) AS first_seen
       FROM fundamental_periods fp
       JOIN metrics m ON m.id = fp.metric_id
      WHERE fp.symbol_id = $1 AND fp.period_type = $2
      ORDER BY fp.period_end, fp.metric_id, fp.observed_at DESC`,
    [id, periodType],
  );
  return res.rows.map((r) => ({
    periodEnd: r.period_end,
    key: r.key.replace(/^fundamentals\./, ''),
    value: r.value,
    observedAt: r.observed_at.toISOString(),
    // When the period was first stored: within a night of its report, for a
    // quarter that came in while the refresh was running.
    firstSeenAt: r.first_seen.toISOString(),
  }));
}

// ── Composite write path ─────────────────────────────────────────────────────

/** Everything one refresh or analysis produced, written together. */
export interface RecordRunInput {
  symbol:      string;
  runId?:      number | null;
  observedAt?: Date;
  financials?:       StockFinancials | null;
  marketSignals?:    MarketSignals | null;
  sectorMedians?:    SectorMedians | null;
  technicalSignals?: TechnicalSignals | null;
  /** ComputedMetrics — the 19 valuation models. */
  metrics?:          unknown;
  /** LLMAnalysis, when this run produced a verdict. */
  verdict?:          LLMAnalysis | null;
  /** The score card behind that verdict — its own domain, its own series. */
  scoreCard?:        ScoreCard | null;
  /** Market rates; what this reading observed joins the global macro series. */
  marketRates?:      FetchedRates | null;
}

export async function recordRunData(input: RecordRunInput): Promise<void> {
  const at = input.observedAt ?? new Date();

  // Snapshots first, projection second — the order matters more than a
  // transaction would. Observations can always be rebuilt from a snapshot, so a
  // crash that leaves a snapshot without its series is recoverable; the reverse
  // is not. Writing the truth before the thing derived from it makes every
  // partial failure fall on the recoverable side.
  if (input.metrics) {
    await saveSnapshot(input.symbol, 'metrics', FINANCIALS_VERSION, input.metrics, input.runId);
  }
  if (input.technicalSignals) {
    await saveSnapshot(input.symbol, 'technical_signals', MARKET_SIGNALS_VERSION, input.technicalSignals, input.runId);
  }
  // The card as published. A rescore rewrites the `score.*` observations at
  // past instants when the rules change; this keeps what the page said then.
  if (input.scoreCard) {
    await saveSnapshot(input.symbol, 'score_card', ANALYSIS_VERSION, input.scoreCard, input.runId);
  }

  const sources: ObservationSource[] = [];
  if (input.financials)       sources.push({ domain: 'financials',  payload: input.financials });
  if (input.metrics)          sources.push({ domain: 'metrics',     payload: input.metrics });
  if (input.marketSignals)    sources.push({ domain: 'signals',     payload: input.marketSignals });
  if (input.sectorMedians)    sources.push({ domain: 'peers',       payload: input.sectorMedians });
  if (input.technicalSignals) sources.push({ domain: 'signals_agg', payload: input.technicalSignals });
  if (input.verdict)          sources.push({ domain: 'verdict',     payload: input.verdict });
  if (input.scoreCard)        sources.push({ domain: 'score',       payload: input.scoreCard });

  await recordObservations(input.symbol, sources, at, input.runId);

  if (input.financials) {
    await recordFundamentals(input.symbol, input.financials, at);
  }

  // The macro block and the market rates describe the market, not this stock,
  // so they land in the global series once regardless of how many symbols a run
  // touches. `recordMacro` upserts on (metric, observed_at), so the second
  // symbol of a nightly pass overwrites rather than duplicating. Only what the
  // reading actually read is recorded: a fallback may price a model for a few
  // minutes, but it is not the market's number for the day.
  //
  // Stamped with the day, not the moment: a night refreshes a hundred stocks
  // and used to write the same reading a hundred times, seconds apart. And the
  // sector ETF is left out — it is this stock's sector, not the market's, and
  // in one global series every sector's return overwrote the last. It stays in
  // the stock's own market signals; the ETF's prices are in `price_bars`.
  const { sectorEtfSymbol: _etf, sectorEtfReturn3M: _etfReturn, ...market } = input.marketSignals?.macro ?? {};
  const global = { ...market, ...(input.marketRates?.observed ?? {}) };
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  if (Object.keys(global).length > 0) await recordMacro(global, day, input.runId);
}

/**
 * The newest score card for a symbol, whatever flag combination produced it.
 *
 * Deliberately combination-blind, like `newestAnalysisAgeDays`: the question
 * the daily refresh asks is "what did we last conclude about this stock", not
 * "what did this exact model conclude". The card is carried forward so the
 * deterministic half can be recomputed against today's price while the prose
 * half — which costs money and changes slowly — stays put.
 */
export async function latestScoreCard(symbol: string): Promise<ScoreCard | null> {
  const id = await symbolId(symbol);
  if (id === null) return null;
  const row = await queryOne<{ data: CachedAnalysisEntry }>(
    `SELECT data FROM documents
      WHERE symbol_id = $1 AND kind = 'verdict' AND schema_ver = $2
        AND data -> 'scoreCard' IS NOT NULL
      ORDER BY produced_at DESC LIMIT 1`,
    [id, ANALYSIS_VERSION],
  );
  return row?.data?.scoreCard ?? null;
}

/**
 * Every score card an analysis has stored for a symbol, oldest first, with the
 * instant it was produced — `latestScoreCard` for any moment in the past.
 */
export async function scoreCardHistory(symbol: string): Promise<{ card: ScoreCard; producedAt: Date }[]> {
  const id = await symbolId(symbol);
  if (id === null) return [];
  const res = await query<{ data: CachedAnalysisEntry; produced_at: Date }>(
    `SELECT data, produced_at FROM documents
      WHERE symbol_id = $1 AND kind = 'verdict' AND schema_ver = $2
        AND data -> 'scoreCard' IS NOT NULL
      ORDER BY produced_at`,
    [id, ANALYSIS_VERSION],
  );
  return res.rows
    .filter((r) => r.data?.scoreCard)
    .map((r) => ({ card: r.data.scoreCard!, producedAt: r.produced_at }));
}

/** Every instant at which a score card was recorded for a symbol. */
export async function scoreInstants(symbol: string): Promise<Date[]> {
  const id = await symbolId(symbol);
  if (id === null) return [];
  const res = await query<{ observed_at: Date }>(
    `SELECT DISTINCT o.observed_at FROM observations o
       JOIN metrics m ON m.id = o.metric_id
      WHERE o.symbol_id = $1 AND m.key = 'score.factor.score'
      ORDER BY o.observed_at`,
    [id],
  );
  return res.rows.map((r) => r.observed_at);
}

/** Newest recorded value of every global macro metric under a prefix. */
export async function latestMacro(prefix: string): Promise<Map<string, number>> {
  const res = await query<{ key: string; value: number }>(
    `SELECT DISTINCT ON (m.key) m.key, o.value
       FROM macro_observations o JOIN metrics m ON m.id = o.metric_id
      WHERE m.key LIKE $1 AND o.value IS NOT NULL
      ORDER BY m.key, o.observed_at DESC`,
    [`${prefix}%`],
  );
  return new Map(res.rows.map((r) => [r.key, r.value]));
}

/**
 * The global macro series under one key prefix, oldest first per key.
 *
 * The rates the models discounted with on any past day are recorded here by
 * the refresh; reading them back is what lets a re-score use that day's rates
 * instead of constants.
 */
export async function macroHistory(prefix: string): Promise<Map<string, { at: number; value: number }[]>> {
  const res = await query<{ key: string; observed_at: Date; value: number }>(
    `SELECT m.key, o.observed_at, o.value
       FROM macro_observations o JOIN metrics m ON m.id = o.metric_id
      WHERE m.key LIKE $1 AND o.value IS NOT NULL
      ORDER BY m.key, o.observed_at`,
    [`${prefix}%`],
  );
  const out = new Map<string, { at: number; value: number }[]>();
  for (const r of res.rows) {
    const list = out.get(r.key) ?? [];
    list.push({ at: r.observed_at.getTime(), value: r.value });
    out.set(r.key, list);
  }
  return out;
}

/**
 * Newest point of several metrics, for every symbol, in one query.
 *
 * The overview needs four numbers out of the score card per row — the headline,
 * the two halves and the confidence — and they are all already series. Reading
 * them from the *series* rather than from the stored verdict document matters:
 * the document is written when the analysis runs, the series when the data
 * refreshes, and it is the refresh that has seen today's price.
 *
 * Enum leaves come back in `text` and numeric ones in `value`, so a caller can
 * ask for `score.final.verdict` alongside `score.final.score` and get both.
 *
 * The reference universe is left out unless asked for: it never appears in
 * the list, but it is what a stock's rank is read against.
 */
export async function latestPointsForAll(
  keys: string[],
  opts: { withReference?: boolean } = {},
): Promise<Map<string, Map<string, SeriesPoint>>> {
  if (keys.length === 0) return new Map();
  const res = await query<{
    symbol: string; key: string; observed_at: Date; value: number | null; value_text: string | null;
  }>(
    `SELECT DISTINCT ON (o.symbol_id, m.key)
            s.symbol, m.key, o.observed_at, o.value, o.value_text
       FROM observations o
       JOIN metrics m ON m.id = o.metric_id
       JOIN symbols s ON s.id = o.symbol_id
      WHERE m.key = ANY($1) AND ($2 OR NOT s.reference)
      ORDER BY o.symbol_id, m.key, o.observed_at DESC`,
    [keys, opts.withReference === true],
  );
  const out = new Map<string, Map<string, SeriesPoint>>();
  for (const r of res.rows) {
    const byKey = out.get(r.symbol) ?? new Map<string, SeriesPoint>();
    byKey.set(r.key, { at: r.observed_at.toISOString(), value: r.value, text: r.value_text });
    out.set(r.symbol, byKey);
  }
  return out;
}

/**
 * Every distinct version of a snapshot kind, oldest first.
 *
 * `captured_at` is when that exact content *first* appeared, which is the date
 * it was true — `last_seen_at` only says when we last confirmed it. For
 * re-scoring history the first appearance is the one that matters: it is the
 * day the numbers moved.
 */
export async function snapshotHistory<T>(
  symbol: string, kind: SnapshotKind, since?: Date,
): Promise<{ data: T; capturedAt: Date }[]> {
  const id = await symbolId(symbol);
  if (id === null) return [];
  const res = await query<{ content: T; captured_at: Date }>(
    `SELECT content, captured_at FROM snapshots
      WHERE symbol_id = $1 AND kind = $2
        AND ($3::timestamptz IS NULL OR captured_at >= $3)
      ORDER BY captured_at`,
    [id, kind, since ?? null],
  );
  return res.rows.map((r) => ({ data: r.content, capturedAt: r.captured_at }));
}

/**
 * Drop one domain's observations at specific instants.
 *
 * `recordObservations` upserts and never deletes, and a null leaf is not
 * written at all — so a metric that *stops* having a value keeps whatever row
 * it last had. Rewriting the same instant therefore leaves the orphan in place,
 * which is how a re-score after a scoring change left a pillar reporting 10/10
 * beside a coverage of 0 %.
 *
 * Scoped to exact timestamps rather than a range on purpose: the live refresh
 * writes its own richer cards at instants of its own, and a range delete would
 * take those with it.
 */
export async function deleteObservations(
  symbol: string, keyPrefix: string, at: Date[],
): Promise<number> {
  const id = await symbolId(symbol);
  if (id === null || at.length === 0) return 0;
  const res = await query(
    `DELETE FROM observations o
      USING metrics m
      WHERE o.metric_id = m.id
        AND o.symbol_id = $1
        AND o.observed_at = ANY($2::timestamptz[])
        AND m.key LIKE $3`,
    [id, at, `${keyPrefix}%`],
  );
  return res.rowCount ?? 0;
}
