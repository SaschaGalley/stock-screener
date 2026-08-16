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
  LLMAnalysis, MarketSignals, NewsItem, SearchTrace, SectorMedians,
  StockFinancials, TechnicalSignals,
} from '../types.js';
import type { PerplexityContext } from '../data/perplexity.js';
import type { DistillBundle } from '../data/distill.js';
import { logger } from '../utils/logger.js';
import { query, queryOne } from './client.js';
import { buildCatalog, keyedArraysFor, metricIds } from './catalog.js';
import { coerce, LeafKind, readPath } from './walk.js';

// ── Schema versions ──────────────────────────────────────────────────────────
// Unchanged in meaning from the file cache: a bump makes older payloads
// unreadable for the models. Crucially it no longer touches `observations` —
// history outlives every version bump now.

export const FINANCIALS_VERSION     = 17;
export const ANALYSIS_VERSION       = 5;
export const NEWS_VERSION           = 1;
export const MARKET_SIGNALS_VERSION = 2;
export const SECTOR_MEDIANS_VERSION = 1;

const FINANCIALS_TTL_MS     = 60 * 60 * 1000;
const NEWS_TTL_MS           = 30 * 60 * 1000;
const MARKET_SIGNALS_TTL_MS = 30 * 60 * 1000;
const SECTOR_MEDIANS_TTL_MS = 24 * 60 * 60 * 1000;
const PERPLEXITY_TTL_MS     = 12 * 60 * 60 * 1000;
const DISTILL_TTL_MS        = 30 * 60 * 1000;

export type SnapshotKind =
  | 'financials' | 'market_signals' | 'metrics'
  | 'sector_medians' | 'news' | 'technical_signals';

export type DocumentKind = 'distill' | 'perplexity' | 'verdict' | 'search_trace';

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
 */
export async function upsertSymbol(symbol: string, profile: SymbolProfile = {}): Promise<number> {
  const sym = symbol.toUpperCase();
  const row = await queryOne<{ id: number }>(
    `INSERT INTO symbols (symbol, company_name, sector, industry, isin, wkn, website, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (symbol) DO UPDATE SET
       company_name = COALESCE(EXCLUDED.company_name, symbols.company_name),
       sector       = COALESCE(EXCLUDED.sector,       symbols.sector),
       industry     = COALESCE(EXCLUDED.industry,     symbols.industry),
       isin         = COALESCE(EXCLUDED.isin,         symbols.isin),
       wkn          = COALESCE(EXCLUDED.wkn,          symbols.wkn),
       website      = COALESCE(EXCLUDED.website,      symbols.website),
       currency     = COALESCE(EXCLUDED.currency,     symbols.currency),
       updated_at   = now()
     RETURNING id`,
    [
      sym, profile.companyName ?? null, profile.sector ?? null, profile.industry ?? null,
      profile.isin ?? null, profile.wkn ?? null, profile.website ?? null, profile.currency ?? null,
    ],
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
 * Every symbol the app knows about — the successor to "a directory containing
 * financials.json". Only symbols that actually have financials count, so a
 * half-finished add doesn't appear in the sidebar as an empty row.
 */
export async function listSymbols(): Promise<string[]> {
  const res = await query<{ symbol: string }>(
    `SELECT s.symbol FROM symbols s
     WHERE EXISTS (SELECT 1 FROM snapshots sn WHERE sn.symbol_id = s.id AND sn.kind = 'financials')
     ORDER BY s.symbol`,
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
      WHERE sn.kind = $1
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

export async function readSectorMedians(symbol: string): Promise<SectorMedians | null> {
  const hit = await latestSnapshot<SectorMedians>(symbol, 'sector_medians', {
    schemaVer: SECTOR_MEDIANS_VERSION, maxAgeMs: SECTOR_MEDIANS_TTL_MS,
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

export async function readPerplexity(symbol: string): Promise<PerplexityContext | null> {
  const doc = await latestDocument<PerplexityContext>(symbol, 'perplexity');
  if (!doc) return null;
  if (Date.now() - new Date(doc.lastSeenAt).getTime() > PERPLEXITY_TTL_MS) return null;
  return doc.data;
}

export async function readPerplexityLax(symbol: string): Promise<PerplexityContext | null> {
  return (await latestDocument<PerplexityContext>(symbol, 'perplexity'))?.data ?? null;
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
  await saveDocument({
    symbol, kind: 'distill',
    variant: data.briefing?.briefingTypeId ?? '',
    content: data.briefing?.body ?? '',
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
  pplx:   'sonar' | 'sonar-pro' | null;
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
 * Tolerant of shape on purpose: analysis schema v3 stored bullCase/bearCase/
 * keyRisks as a single prose string where v4 onwards stores bullet arrays, and
 * those older verdicts are exactly the history worth keeping. A renderer that
 * insisted on arrays would throw on the oldest and most interesting rows.
 */
function bullets(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => `- ${String(v)}`);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function verdictText(a: LLMAnalysis): string {
  return [
    a.thesis ?? '',
    '',
    `Empfehlung: ${a.recommendation} · Score ${a.score}/10 · Fair Value ${a.fairValueEstimate}`,
    '',
    'Bull Case:', ...bullets(a.bullCase),
    '',
    'Bear Case:', ...bullets(a.bearCase),
    '',
    'Risiken:', ...bullets(a.keyRisks),
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
): Promise<void> {
  const hash = analysisHash(flags);
  const entry: CachedAnalysisEntry = {
    flags, hash, llmAnalysis,
    generatedAt: new Date().toISOString(),
    ...(searches && searches.providers.length > 0 ? { searches } : {}),
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
      WHERE d.kind = 'verdict' AND d.schema_ver = $1
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
      WHERE m.key = $1 AND o.value IS NOT NULL
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
      WHERE m.key = $1 AND ($2::timestamptz IS NULL OR o.observed_at >= $2)
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
    // Yahoo labels these "3Q2024"; without a real end date the quarter cannot
    // be placed on a calendar, so those entries are skipped rather than guessed.
    const end = quarterLabelToDate(s.quarter);
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
): Promise<{ periodEnd: string; key: string; value: number; observedAt: string }[]> {
  const id = await symbolId(symbol);
  if (id === null) return [];
  const res = await query<{
    period_end: Date; key: string; value: number; observed_at: Date;
  }>(
    `SELECT DISTINCT ON (fp.period_end, fp.metric_id)
            fp.period_end, m.key, fp.value, fp.observed_at
       FROM fundamental_periods fp
       JOIN metrics m ON m.id = fp.metric_id
      WHERE fp.symbol_id = $1 AND fp.period_type = $2
      ORDER BY fp.period_end, fp.metric_id, fp.observed_at DESC`,
    [id, periodType],
  );
  return res.rows.map((r) => ({
    periodEnd: r.period_end.toISOString().slice(0, 10),
    key: r.key.replace(/^fundamentals\./, ''),
    value: r.value,
    observedAt: r.observed_at.toISOString(),
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
  /** FRED rates; merged into the global macro series, not stored per symbol. */
  marketRates?:      { riskFreeRate: number; aaaBondYield: number } | null;
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

  const sources: ObservationSource[] = [];
  if (input.financials)       sources.push({ domain: 'financials',  payload: input.financials });
  if (input.metrics)          sources.push({ domain: 'metrics',     payload: input.metrics });
  if (input.marketSignals)    sources.push({ domain: 'signals',     payload: input.marketSignals });
  if (input.sectorMedians)    sources.push({ domain: 'peers',       payload: input.sectorMedians });
  if (input.technicalSignals) sources.push({ domain: 'signals_agg', payload: input.technicalSignals });
  if (input.verdict)          sources.push({ domain: 'verdict',     payload: input.verdict });

  await recordObservations(input.symbol, sources, at, input.runId);

  if (input.financials) {
    await recordFundamentals(input.symbol, input.financials, at);
  }

  // The macro block and the FRED rates describe the market, not this stock, so
  // they land in the global series once regardless of how many symbols a run
  // touches. `recordMacro` upserts on (metric, observed_at), so the second
  // symbol of a nightly pass overwrites rather than duplicating.
  const global = { ...(input.marketSignals?.macro ?? {}), ...(input.marketRates ?? {}) };
  if (Object.keys(global).length > 0) await recordMacro(global, at, input.runId);
}
