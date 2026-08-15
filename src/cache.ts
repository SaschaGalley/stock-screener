import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join, isAbsolute, resolve, relative } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { StockFinancials, LLMAnalysis, MarketSignals, NewsItem, SearchTrace, SectorMedians } from './types.js';
import { logger } from './utils/logger.js';
import { PerplexityContext, PERPLEXITY_PROMPT_HASH } from './data/perplexity.js';
import { DistillBundle, DISTILL_FETCH_HASH } from './data/distill.js';
// Type-only: keeps this module free of a runtime edge to the entity client
// (which would close a cycle back through data/distill.ts).
import type { DistillEntityRef } from './data/distill-entities.js';
import { HistoryPoint, HISTORY_VERSION, mergeHistoryPoint } from './history.js';

const FINANCIALS_TTL_MS    = 60 * 60 * 1000;       // 1 hour
// Analyses do NOT expire on a clock — invalidation is purely hash-based:
// same flag combination ⇒ same hash ⇒ same cache file. Bumping ANALYSIS_VERSION
// or deleting the file are the only ways to invalidate.
const NEWS_TTL_MS          = 30 * 60 * 1000;       // 30 min
const MARKET_SIGNALS_TTL_MS = 30 * 60 * 1000;      // 30 min (technicals + options change fast)
const PERPLEXITY_TTL_MS    = 12 * 60 * 60 * 1000;  // 12 hours
// Distill briefings are generated upstream on Distill's own schedule. We can
// re-hit the API cheaply, but the briefing corpus only changes when admins
// publish new ones — 30min keeps the screener responsive without hammering.
const DISTILL_TTL_MS       = 30 * 60 * 1000;

// Bump to invalidate all cached entries of that type.
// EXPORTED so server.ts validates against the same numbers — keeping two
// hand-synced copies previously drifted (server stuck at 15 while writers wrote
// 17, marking every financials file permanently "stale").
export const FINANCIALS_VERSION     = 17;  // FX-convert quarterly + forward revenue; clamp tax rate; avgPE5Y date keying; EV fallback
export const ANALYSIS_VERSION       = 5;   // LLM output now in German (bullCase/bearCase/keyRisks/thesis)
export const NEWS_VERSION           = 1;
export const MARKET_SIGNALS_VERSION = 2;   // technicals expanded with EMAs, Stoch, CCI, WilliamsR, Momentum
const SUBMISSIONS_VERSION    = 1;

function resolveCacheRoot(rawDir: string): string {
  if (rawDir.startsWith('~')) return join(homedir(), rawDir.slice(1));
  if (isAbsolute(rawDir)) return rawDir;
  return resolve(process.cwd(), rawDir);
}

/**
 * Resolve a per-symbol cache directory, confined to the cache root. The symbol
 * reaches this from untrusted HTTP route params, so reject anything that would
 * escape the root (traversal like "../.." or an absolute path) before it
 * touches the filesystem — see also the route-boundary validation in server.ts.
 */
export function symbolDir(rawDir: string, symbol: string): string {
  const root = resolveCacheRoot(rawDir);
  const dir  = resolve(root, symbol);
  const rel  = relative(root, dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) {
    throw new Error(`Unsafe cache symbol: ${JSON.stringify(symbol)}`);
  }
  return dir;
}

/**
 * Every symbol with cached financials, i.e. everything the app knows about.
 * The presence of `financials.json` is the marker — a directory holding only a
 * stray file is not a stock.
 */
export function listCachedSymbols(rawDir: string): string[] {
  const root = resolveCacheRoot(rawDir);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'financials.json')))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Validate a hash-keyed cache filename component (analysis hashes are md5 hex). */
export function assertSafeHash(hash: string): string {
  if (!/^[a-f0-9]{6,64}$/i.test(hash)) {
    throw new Error(`Unsafe cache hash: ${JSON.stringify(hash)}`);
  }
  return hash;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

interface CacheEntry<T> { v: number | string; ts: number; data: T }

function readEntry<T>(file: string): CacheEntry<T> | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')) as CacheEntry<T>; }
  catch { return null; }
}

function writeEntry(file: string, version: number | string, data: unknown): void {
  // Atomic: write to a temp file in the same dir, then rename (atomic on POSIX
  // within a filesystem). Prevents a corrupt/truncated cache file if the
  // process is killed mid-write or two writers race on the same path.
  const json = JSON.stringify({ v: version, ts: Date.now(), data }, null, 2);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, json, 'utf-8');
  renameSync(tmp, file);
}

// ── Financials ────────────────────────────────────────────────────────────────

export function readFinancials(rawDir: string, symbol: string): StockFinancials | null {
  const file = join(symbolDir(rawDir, symbol), 'financials.json');
  const entry = readEntry<StockFinancials>(file);
  if (!entry) return null;
  if (entry.v !== FINANCIALS_VERSION) {
    logger.debug(`Financials cache version mismatch for ${symbol} — refetching`);
    return null;
  }
  if (Date.now() - entry.ts > FINANCIALS_TTL_MS) {
    logger.debug(`Financials cache expired for ${symbol}`);
    return null;
  }
  logger.debug(`Financials cache hit for ${symbol} (${Math.round((Date.now() - entry.ts) / 60000)}m old)`);
  return entry.data;
}

/**
 * Financials regardless of age or schema version — for consumers that only need
 * slow-moving identity fields (company name, ISIN, sector) and would rather
 * have a stale answer than none. Never use this where numbers matter.
 */
export function readFinancialsLax(rawDir: string, symbol: string): StockFinancials | null {
  const file = join(symbolDir(rawDir, symbol), 'financials.json');
  return readEntry<StockFinancials>(file)?.data ?? null;
}

export function writeFinancials(rawDir: string, symbol: string, data: StockFinancials): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'financials.json'), FINANCIALS_VERSION, data);
    logger.debug(`Cached financials for ${symbol} → ${dir}`);
  } catch (e) {
    logger.warn(`Could not write financials cache: ${(e as Error).message}`);
  }
}

// ── LLM Analysis (multi, hash-keyed by flag combination) ─────────────────────

/** Flag combination that uniquely identifies a cached LLM analysis. */
export interface AnalysisFlagsKey {
  model:  string;            // resolved model id, e.g. 'claude-sonnet-5'
  search: string;            // 'none' | 'brave' | 'tavily' | 'claude' | 'openai' | 'openai-tavily'
  pplx:   'sonar' | 'sonar-pro' | null;
}

/** Stable 12-char hash for a flag combination. Used as the analysis filename. */
export function analysisHash(flags: AnalysisFlagsKey): string {
  const s = `${flags.model}|${flags.search}|${flags.pplx ?? 'none'}`;
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/** Stored analysis blob. */
export interface CachedAnalysisEntry {
  flags:       AnalysisFlagsKey;
  hash:        string;
  llmAnalysis: LLMAnalysis;
  generatedAt: string;       // ISO timestamp when LLM was called
  /**
   * Debug trace of every search provider that ran for this analysis — raw
   * Tavily/Brave results plus the queries Claude/OpenAI issued via native
   * search. Optional for backwards-compat with older cache entries.
   */
  searches?:   SearchTrace;
}

/** Manifest entry for one cached analysis (lightweight, no LLM payload). */
export interface AnalysisManifestEntry {
  hash:        string;
  flags:       AnalysisFlagsKey;
  generatedAt: string;
  ageMinutes:  number;       // computed at read time — purely informational, not a freshness gate
}

function analysesDir(rawDir: string, symbol: string): string {
  return join(symbolDir(rawDir, symbol), 'analyses');
}

/**
 * Read a cached analysis. Hash-based — same flag combination ⇒ same cache file.
 * No TTL: the cache is invalidated only by (a) bumping ANALYSIS_VERSION, which
 * makes old entries schema-incompatible, or (b) deleting the file. The
 * "older-than-data" case is detected at the bundle layer and surfaced via the
 * StaleBanner so the user can decide whether to re-run.
 */
export function readAnalysis(rawDir: string, symbol: string, flags: AnalysisFlagsKey): CachedAnalysisEntry | null {
  const file = join(analysesDir(rawDir, symbol), `${analysisHash(flags)}.json`);
  const entry = readEntry<CachedAnalysisEntry>(file);
  if (!entry || entry.v !== ANALYSIS_VERSION) return null;
  logger.debug(`Analysis cache hit for ${symbol} (${analysisHash(flags)})`);
  return entry.data;
}

export function writeAnalysis(
  rawDir: string,
  symbol: string,
  flags: AnalysisFlagsKey,
  llmAnalysis: LLMAnalysis,
  searches?: SearchTrace,
): void {
  const dir = analysesDir(rawDir, symbol);
  const hash = analysisHash(flags);
  try {
    ensureDir(dir);
    const entry: CachedAnalysisEntry = {
      flags, hash, llmAnalysis,
      generatedAt: new Date().toISOString(),
      ...(searches && searches.providers.length > 0 ? { searches } : {}),
    };
    writeEntry(join(dir, `${hash}.json`), ANALYSIS_VERSION, entry);
    logger.debug(`Cached analysis for ${symbol} (${hash})`);
  } catch (e) {
    logger.warn(`Could not write analysis cache: ${(e as Error).message}`);
  }
}

/** List all cached analysis combinations for a symbol with freshness metadata. */
export function listAnalyses(rawDir: string, symbol: string): AnalysisManifestEntry[] {
  const dir = analysesDir(rawDir, symbol);
  if (!existsSync(dir)) return [];
  const out: AnalysisManifestEntry[] = [];
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const entry = readEntry<CachedAnalysisEntry>(join(dir, file));
    if (!entry || entry.v !== ANALYSIS_VERSION) continue;
    const ageMs = Date.now() - entry.ts;
    out.push({
      hash:        entry.data.hash,
      flags:       entry.data.flags,
      generatedAt: entry.data.generatedAt,
      ageMinutes:  Math.round(ageMs / 60000),
    });
  }
  return out;
}

// ── News ──────────────────────────────────────────────────────────────────────

export function readNews(rawDir: string, symbol: string): NewsItem[] | null {
  const file = join(symbolDir(rawDir, symbol), 'news.json');
  const entry = readEntry<NewsItem[]>(file);
  if (!entry) return null;
  if (entry.v !== NEWS_VERSION) return null;
  if (Date.now() - entry.ts > NEWS_TTL_MS) {
    logger.debug(`News cache expired for ${symbol}`);
    return null;
  }
  logger.debug(`News cache hit for ${symbol}`);
  return entry.data;
}

export function writeNews(rawDir: string, symbol: string, data: NewsItem[]): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'news.json'), NEWS_VERSION, data);
    logger.debug(`Cached news for ${symbol}`);
  } catch (e) {
    logger.warn(`Could not write news cache: ${(e as Error).message}`);
  }
}

// ── Market Signals (technicals + revisions + options + macro) ────────────────

export function readMarketSignals(rawDir: string, symbol: string): MarketSignals | null {
  const file = join(symbolDir(rawDir, symbol), 'market-signals.json');
  const entry = readEntry<MarketSignals>(file);
  if (!entry) return null;
  if (entry.v !== MARKET_SIGNALS_VERSION) return null;
  if (Date.now() - entry.ts > MARKET_SIGNALS_TTL_MS) {
    logger.debug(`Market signals cache expired for ${symbol}`);
    return null;
  }
  logger.debug(`Market signals cache hit for ${symbol} (${Math.round((Date.now() - entry.ts) / 60000)}m old)`);
  return entry.data;
}

export function writeMarketSignals(rawDir: string, symbol: string, data: MarketSignals): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'market-signals.json'), MARKET_SIGNALS_VERSION, data);
    logger.debug(`Cached market signals for ${symbol}`);
  } catch (e) {
    logger.warn(`Could not write market-signals cache: ${(e as Error).message}`);
  }
}

// ── EDGAR Submissions ─────────────────────────────────────────────────────────

export interface FilingEntry {
  accessionNumber: string;
  form: string;
  filingDate: string;
  primaryDocument: string;
  description: string;
  localFile?: string;  // filename inside the submissions/ subfolder
}

export interface SubmissionsMeta {
  cik: string;
  entityName: string;
  filings: FilingEntry[];
  fetchedAt: string;
}

export function readSubmissions(rawDir: string, symbol: string): SubmissionsMeta | null {
  const file = join(symbolDir(rawDir, symbol), 'submissions.json');
  const entry = readEntry<SubmissionsMeta>(file);
  if (!entry) return null;
  if (entry.v !== SUBMISSIONS_VERSION) return null;
  logger.debug(`Submissions cache hit for ${symbol}`);
  return entry.data;
}

export function writeSubmissions(rawDir: string, symbol: string, data: SubmissionsMeta): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'submissions.json'), SUBMISSIONS_VERSION, data);
    logger.debug(`Cached submissions for ${symbol}`);
  } catch (e) {
    logger.warn(`Could not write submissions cache: ${(e as Error).message}`);
  }
}

export function writeSubmissionFile(rawDir: string, symbol: string, filename: string, content: string): void {
  const dir = join(symbolDir(rawDir, symbol), 'submissions');
  try {
    ensureDir(dir);
    writeFileSync(join(dir, filename), content, 'utf-8');
    logger.debug(`Saved filing: ${filename}`);
  } catch (e) {
    logger.warn(`Could not write filing: ${(e as Error).message}`);
  }
}

export function getSubmissionsDir(rawDir: string, symbol: string): string {
  return join(symbolDir(rawDir, symbol), 'submissions');
}

// ── Perplexity ────────────────────────────────────────────────────────────────

export function readPerplexity(rawDir: string, symbol: string): PerplexityContext | null {
  const file = join(symbolDir(rawDir, symbol), 'perplexity.json');
  const entry = readEntry<PerplexityContext>(file);
  if (!entry) return null;
  if (entry.v !== PERPLEXITY_PROMPT_HASH) return null;
  if (Date.now() - entry.ts > PERPLEXITY_TTL_MS) {
    logger.debug(`Perplexity cache expired for ${symbol}`);
    return null;
  }
  logger.debug(`Perplexity cache hit for ${symbol} (${Math.round((Date.now() - entry.ts) / 3600000)}h old)`);
  return entry.data;
}

export function writePerplexity(rawDir: string, symbol: string, data: PerplexityContext): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'perplexity.json'), PERPLEXITY_PROMPT_HASH, data);
    logger.debug(`Cached Perplexity context for ${symbol} (hash ${PERPLEXITY_PROMPT_HASH})`);
  } catch (e) {
    logger.warn(`Could not write Perplexity cache: ${(e as Error).message}`);
  }
}

// ── Sector medians (Finnhub peer group) ──────────────────────────────────────
// The single most expensive read in the app: one peers call plus up to eight
// per-peer metric calls, i.e. nine requests against a 60/min free tier — paid
// on every stock the web UI opened. Peer medians move on the timescale of
// quarterly reports, so a day-long TTL costs nothing in accuracy.

const SECTOR_MEDIANS_TTL_MS = 24 * 60 * 60 * 1000;
const SECTOR_MEDIANS_VERSION = 1;

export function readSectorMedians(rawDir: string, symbol: string): SectorMedians | null {
  const file = join(symbolDir(rawDir, symbol), 'sector-medians.json');
  const entry = readEntry<SectorMedians>(file);
  if (!entry || entry.v !== SECTOR_MEDIANS_VERSION) return null;
  if (Date.now() - entry.ts > SECTOR_MEDIANS_TTL_MS) {
    logger.debug(`Sector medians cache expired for ${symbol}`);
    return null;
  }
  logger.debug(`Sector medians cache hit for ${symbol} (${Math.round((Date.now() - entry.ts) / 3600000)}h old)`);
  return entry.data;
}

export function writeSectorMedians(rawDir: string, symbol: string, data: SectorMedians): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'sector-medians.json'), SECTOR_MEDIANS_VERSION, data);
  } catch (e) {
    logger.warn(`Could not write sector medians cache: ${(e as Error).message}`);
  }
}

// ── Distill briefings ─────────────────────────────────────────────────────────

export function readDistill(rawDir: string, symbol: string): DistillBundle | null {
  const file = join(symbolDir(rawDir, symbol), 'distill.json');
  const entry = readEntry<DistillBundle>(file);
  if (!entry) return null;
  if (entry.v !== DISTILL_FETCH_HASH) return null;
  if (Date.now() - entry.ts > DISTILL_TTL_MS) {
    logger.debug(`Distill cache expired for ${symbol}`);
    return null;
  }
  logger.debug(`Distill cache hit for ${symbol} (${Math.round((Date.now() - entry.ts) / 60000)}m old)`);
  return entry.data;
}

export function writeDistill(rawDir: string, symbol: string, data: DistillBundle): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'distill.json'), DISTILL_FETCH_HASH, data);
    logger.debug(`Cached Distill briefings for ${symbol} (hash ${DISTILL_FETCH_HASH})`);
  } catch (e) {
    logger.warn(`Could not write Distill cache: ${(e as Error).message}`);
  }
}

// ── Distill entity resolution (identifier → UUID) ─────────────────────────────
// Deliberately TTL-free: an entity UUID is stable forever, so re-searching on a
// clock would just burn a request per run. It is invalidated only by a version
// bump, by pointing at a different Distill deployment, or by an explicit clear
// after the API reports the id gone (404) — see src/distill-service.ts.

const DISTILL_ENTITY_VERSION = 1;

export function readDistillEntity(rawDir: string, symbol: string, baseUrl: string): DistillEntityRef | null {
  const file = join(symbolDir(rawDir, symbol), 'distill-entity.json');
  const entry = readEntry<DistillEntityRef>(file);
  if (!entry) return null;
  if (entry.v !== DISTILL_ENTITY_VERSION) return null;
  const data = entry.data;
  if (!data?.id) return null;
  // Entity ids are per-installation — never reuse one resolved against a
  // different Distill deployment.
  if (data.baseUrl !== baseUrl) {
    logger.debug(`Distill entity for ${symbol} was resolved against ${data.baseUrl} — re-resolving for ${baseUrl}`);
    return null;
  }
  logger.debug(`Distill entity cache hit for ${symbol}: ${data.id} (${data.displayName})`);
  return data;
}

export function writeDistillEntity(rawDir: string, symbol: string, data: DistillEntityRef): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'distill-entity.json'), DISTILL_ENTITY_VERSION, data);
    logger.debug(`Cached Distill entity for ${symbol}: ${data.id} (${data.matchedOn}="${data.query}")`);
  } catch (e) {
    logger.warn(`Could not write Distill entity cache: ${(e as Error).message}`);
  }
}

/** Drop a mapping the API has disowned. Missing file is not an error. */
export function clearDistillEntity(rawDir: string, symbol: string): void {
  const file = join(symbolDir(rawDir, symbol), 'distill-entity.json');
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch (e) {
    logger.warn(`Could not clear Distill entity cache: ${(e as Error).message}`);
  }
}

// ── History (append-only time series per symbol) ──────────────────────────────
// No TTL and no staleness: this file IS the record of how a stock's numbers
// moved. Only a version bump discards it, and that should be rare enough to
// hurt — history is the one thing here that cannot be refetched.

export function readHistory(rawDir: string, symbol: string): HistoryPoint[] {
  const file = join(symbolDir(rawDir, symbol), 'history.json');
  const entry = readEntry<HistoryPoint[]>(file);
  if (!entry || entry.v !== HISTORY_VERSION) return [];
  return Array.isArray(entry.data) ? entry.data : [];
}

/**
 * Append one point, replacing a same-source point from the same day. Best
 * effort by design: history is an observation of a run, never its purpose, so a
 * failed write warns instead of failing the analysis that produced it.
 */
export function appendHistory(rawDir: string, symbol: string, point: HistoryPoint): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    const next = mergeHistoryPoint(readHistory(rawDir, symbol), point);
    writeEntry(join(dir, 'history.json'), HISTORY_VERSION, next);
    logger.debug(`History for ${symbol}: ${next.length} point(s) after ${point.source} write`);
  } catch (e) {
    logger.warn(`Could not write history for ${symbol}: ${(e as Error).message}`);
  }
}
