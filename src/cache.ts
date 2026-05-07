import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { homedir } from 'os';
import { StockFinancials, LLMAnalysis, MarketSignals, NewsItem } from './types.js';
import { logger } from './utils/logger.js';
import { PerplexityContext, PERPLEXITY_PROMPT_HASH } from './data/perplexity.js';

const FINANCIALS_TTL_MS    = 60 * 60 * 1000;       // 1 hour
const ANALYSIS_TTL_MS      = 6 * 60 * 60 * 1000;   // 6 hours
const NEWS_TTL_MS          = 30 * 60 * 1000;       // 30 min
const MARKET_SIGNALS_TTL_MS = 30 * 60 * 1000;      // 30 min (technicals + options change fast)
const PERPLEXITY_TTL_MS    = 12 * 60 * 60 * 1000;  // 12 hours

// Bump to invalidate all cached entries of that type
const FINANCIALS_VERSION     = 12;  // bump when StockFinancials schema changes
const ANALYSIS_VERSION       = 2;  // bumped — prompt now includes composite IV + RIM/NCAV/peer-multiples
const NEWS_VERSION           = 1;
const MARKET_SIGNALS_VERSION = 1;

function resolveCacheRoot(rawDir: string): string {
  if (rawDir.startsWith('~')) return join(homedir(), rawDir.slice(1));
  if (isAbsolute(rawDir)) return rawDir;
  return resolve(process.cwd(), rawDir);
}

export function symbolDir(rawDir: string, symbol: string): string {
  return join(resolveCacheRoot(rawDir), symbol);
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
  writeFileSync(file, JSON.stringify({ v: version, ts: Date.now(), data }, null, 2), 'utf-8');
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

// ── LLM Analysis ─────────────────────────────────────────────────────────────

export function readAnalysis(rawDir: string, symbol: string): LLMAnalysis | null {
  const file = join(symbolDir(rawDir, symbol), 'analysis.json');
  const entry = readEntry<LLMAnalysis>(file);
  if (!entry) return null;
  if (entry.v !== ANALYSIS_VERSION) return null;
  if (Date.now() - entry.ts > ANALYSIS_TTL_MS) {
    logger.debug(`Analysis cache expired for ${symbol}`);
    return null;
  }
  logger.debug(`Analysis cache hit for ${symbol}`);
  return entry.data;
}

export function writeAnalysis(rawDir: string, symbol: string, data: LLMAnalysis): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'analysis.json'), ANALYSIS_VERSION, data);
    logger.debug(`Cached analysis for ${symbol}`);
  } catch (e) {
    logger.warn(`Could not write analysis cache: ${(e as Error).message}`);
  }
}

// ── News ──────────────────────────────────────────────────────────────────────

export function readNews(rawDir: string, symbol: string): NewsItem[] | null {
  const file = join(symbolDir(rawDir, symbol), 'news.json');
  const entry = readEntry<NewsItem[]>(file);
  if (!entry) return null;
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
  logger.debug(`Submissions cache hit for ${symbol}`);
  return entry.data;
}

export function writeSubmissions(rawDir: string, symbol: string, data: SubmissionsMeta): void {
  const dir = symbolDir(rawDir, symbol);
  try {
    ensureDir(dir);
    writeEntry(join(dir, 'submissions.json'), 1, data);
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
