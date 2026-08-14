import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { getConfig } from './config.js';
import { logger } from './utils/logger.js';
import { runAnalysis } from './cli.js';
import {
  symbolDir,
  listAnalyses,
  readAnalysis,
  AnalysisFlagsKey,
  analysisHash,
  readDistill,
  writeDistill,
  FINANCIALS_VERSION,
  MARKET_SIGNALS_VERSION,
} from './cache.js';
import { StockFinancials, MarketSignals, NewsItem, SectorMedians } from './types.js';
import { MODELS } from './models.js';
import { PerplexityContext } from './data/perplexity.js';
import {
  DistillBundle,
  DistillReadOnlyError,
  DistillUnauthorizedError,
  DistillAmbiguousTypeError,
  DistillEntityUnresolvedError,
} from './data/distill.js';
import { distillHintsFor, refreshDistillBriefing } from './distill-service.js';
import { getMarketRates } from './data/fred.js';
import { getSectorMedians } from './data/finnhub.js';
import { computeAllMetrics } from './analysis/computeMetrics.js';
import { deriveTechnicalSignals } from './analysis/signals.js';
import { refreshStockData } from './refresh.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const PORT = Number(process.env.PORT ?? 4317);

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveCacheRoot(rawDir: string): string {
  if (rawDir.startsWith('~')) return join(homedir(), rawDir.slice(1));
  if (isAbsolute(rawDir)) return rawDir;
  return resolve(process.cwd(), rawDir);
}

interface CacheRead<T> {
  data:  T | null;
  /** True when the file exists but its version doesn't match the expected
   *  schema version. The data is still returned so the UI can render what
   *  it has (frontend components handle missing fields defensively). */
  stale: boolean;
}

/** Read a versioned cache file. Always returns the data when present, plus
 *  a `stale` flag so the caller can display a "refresh me" banner. */
function readJsonEntry<T>(file: string, expectedVersion?: number): CacheRead<T> {
  if (!existsSync(file)) return { data: null, stale: false };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { v?: unknown; data?: T };
    const stale = expectedVersion !== undefined && parsed.v !== expectedVersion;
    if (stale) logger.debug(`Cache version mismatch for ${file} (got ${parsed.v}, want ${expectedVersion})`);
    return { data: parsed.data ?? null, stale };
  } catch {
    return { data: null, stale: false };
  }
}

// Schema versions are imported from cache.ts (single source of truth) — the
// old hand-synced local copies drifted (server stuck at 15 while writers wrote
// 17), marking every financials file permanently "stale".

/** File mtime in ms, or null if the file is gone — avoids a TOCTOU throw when a
 *  concurrent DELETE/refresh removes the file between existsSync and statSync. */
function safeMtime(file: string): number | null {
  try { return statSync(file).mtime.getTime(); } catch { return null; }
}

function listCachedSymbols(cacheDir: string): string[] {
  const root = resolveCacheRoot(cacheDir);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'financials.json')))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Combined buy/hold/sell consensus shown as a thin band on the stock list.
 * Aggregates two sources with AI-leaning weights:
 *   - All cached LLM analyses for this symbol (each one votes its recommendation)
 *   - Analyst recommendation counts from Yahoo (strong-buy through strong-sell)
 * AI carries 0.6 weight, analysts 0.4. If only one source is available it
 * gets 1.0 weight (so the bar still shows something useful).
 */
interface ConsensusBand {
  buy:  number;   // 0–1
  hold: number;   // 0–1
  sell: number;   // 0–1
  /** Number of vote sources that contributed (≥1 for the band to render). */
  sources: number;
}

interface StockSummary {
  symbol:        string;
  companyName:   string;
  sector:        string | null;
  industry:      string | null;
  price:         number | null;
  marketCap:     number | null;
  website:       string | null;
  logoDomain:    string | null;       // domain for clearbit-style lookup
  cachedAt:      string;              // ISO timestamp of financials.json mtime
  analysisCount: number;              // how many cached LLM analyses exist
  consensus:     ConsensusBand | null; // for the sidebar buy/hold/sell band
}

function recommendationToVote(rec: string): 'buy' | 'hold' | 'sell' {
  if (rec.includes('BUY')) return 'buy';
  if (rec.includes('SELL')) return 'sell';
  return 'hold';
}

function computeConsensus(f: StockFinancials, cacheDir: string, symbol: string): ConsensusBand | null {
  // ── AI source: aggregate ALL cached LLM analyses (each combo votes once) ──
  let aiBuy = 0, aiHold = 0, aiSell = 0, aiCount = 0;
  for (const entry of listAnalyses(cacheDir, symbol)) {
    const cached = readAnalysis(cacheDir, symbol, entry.flags);
    if (!cached) continue;
    const v = recommendationToVote(cached.llmAnalysis.recommendation);
    if (v === 'buy')  aiBuy++;
    else if (v === 'sell') aiSell++;
    else aiHold++;
    aiCount++;
  }
  const aiPresent = aiCount > 0;
  const aiBuyP  = aiPresent ? aiBuy  / aiCount : 0;
  const aiHoldP = aiPresent ? aiHold / aiCount : 0;
  const aiSellP = aiPresent ? aiSell / aiCount : 0;

  // ── Analyst source: Yahoo's recommendation breakdown ──────────────────────
  const sb = f.analystStrongBuy  ?? 0;
  const b  = f.analystBuy        ?? 0;
  const h  = f.analystHold       ?? 0;
  const s  = f.analystSell       ?? 0;
  const ss = f.analystStrongSell ?? 0;
  const aTotal = sb + b + h + s + ss;
  const analystPresent = aTotal > 0;
  const aBuyP  = analystPresent ? (sb + b) / aTotal : 0;
  const aHoldP = analystPresent ? h / aTotal        : 0;
  const aSellP = analystPresent ? (s + ss) / aTotal : 0;

  if (!aiPresent && !analystPresent) return null;

  // Weights: AI dominates when present, analysts fill in. If only one source
  // is available it gets full weight on its own.
  const aiW       = aiPresent && analystPresent ? 0.6 : aiPresent ? 1 : 0;
  const analystW  = aiPresent && analystPresent ? 0.4 : analystPresent ? 1 : 0;

  const buy  = aiBuyP  * aiW + aBuyP  * analystW;
  const hold = aiHoldP * aiW + aHoldP * analystW;
  const sell = aiSellP * aiW + aSellP * analystW;
  const sum  = buy + hold + sell;
  if (sum === 0) return null;

  return {
    buy:  buy  / sum,
    hold: hold / sum,
    sell: sell / sum,
    sources: (aiPresent ? 1 : 0) + (analystPresent ? 1 : 0),
  };
}

function logoDomainFromWebsite(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function buildStockSummary(cacheDir: string, symbol: string): StockSummary | null {
  const dir = symbolDir(cacheDir, symbol);
  const financialsFile = join(dir, 'financials.json');
  if (!existsSync(financialsFile)) return null;

  const { data: f } = readJsonEntry<StockFinancials>(financialsFile);
  if (!f) return null;

  const stat = statSync(financialsFile);
  const analyses = listAnalyses(cacheDir, symbol);

  return {
    symbol,
    companyName:   f.companyName ?? symbol,
    sector:        f.sector ?? null,
    industry:      f.industry ?? null,
    price:         typeof f.price === 'number' ? f.price : null,
    marketCap:     typeof f.marketCap === 'number' ? f.marketCap : null,
    website:       f.website ?? null,
    logoDomain:    logoDomainFromWebsite(f.website ?? null),
    cachedAt:      stat.mtime.toISOString(),
    analysisCount: analyses.length,
    consensus:     computeConsensus(f, cacheDir, symbol),
  };
}

// Best-effort symbol vs query auto-detection.
// Tickers are typically 1–5 uppercase chars, optionally with one suffix segment
// like ".DE", "-A", "/P", and no spaces. Anything else is treated as a query.
function looksLikeSymbol(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.includes(' ')) return false;
  return /^[A-Za-z][A-Za-z0-9.\-/:]{0,9}$/.test(trimmed);
}

// ── App Setup ────────────────────────────────────────────────────────────────

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Logging middleware
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.url}`);
    next();
  });

  // ── Route-param validation (security: these params become filesystem paths) ──
  // Reject any :symbol / :hash that isn't a plausible ticker / md5-hex before it
  // can reach symbolDir()/file paths. Defends against path traversal
  // (e.g. DELETE /api/stocks/..%2f..%2f..) at the boundary; symbolDir() also
  // confines to the cache root as defense-in-depth. Must start alphanumeric
  // (no leading dot) so "../" and ".." can never match.
  const SAFE_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,14}$/;
  const SAFE_HASH   = /^[a-f0-9]{6,64}$/i;
  app.param('symbol', (req, res, next, value) => {
    if (typeof value !== 'string' || !SAFE_SYMBOL.test(value)) {
      res.status(400).json({ error: 'invalid symbol' });
      return;
    }
    next();
  });
  app.param('hash', (req, res, next, value) => {
    if (typeof value !== 'string' || !SAFE_HASH.test(value)) {
      res.status(400).json({ error: 'invalid hash' });
      return;
    }
    next();
  });

  const cfg = getConfig();
  const cacheDir = cfg.cacheDir;

  // ── GET /api/stocks ────────────────────────────────────────────────────────
  app.get('/api/stocks', (_req, res) => {
    const symbols = listCachedSymbols(cacheDir);
    const summaries = symbols
      .map((s) => buildStockSummary(cacheDir, s))
      .filter((s): s is StockSummary => s !== null)
      .sort((a, b) => a.companyName.localeCompare(b.companyName));
    res.json({ stocks: summaries });
  });

  // ── POST /api/stocks/:symbol/refresh-data ──────────────────────────────────
  // Force-refresh the data layer (Yahoo + Finnhub + FRED + macro + technicals)
  // for a symbol without touching cached LLM analyses, Perplexity, or reports.
  app.post('/api/stocks/:symbol/refresh-data', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const data = await refreshStockData(symbol);
      res.json({ ok: true, ...data });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/stocks/:symbol/distill-refresh ───────────────────────────────
  // Triggers Distill's POST /api/v1/briefings/refresh — runs the upstream
  // distill drain + (re)briefing for this ticker and writes the result back
  // into our distill.json cache. Body intentionally has no `briefing_type_id`:
  // Distill picks the project's default briefing type server-side.
  //
  // Long-running by nature (drain + LLM can be minutes for first-touch
  // tickers). We extend Node's per-request socket timeout to 5 min so the
  // proxy default doesn't kill it. 403 from Distill (read-only key) gets
  // converted to a clean 403 here so the frontend can show the disabled
  // affordance without parsing an opaque error.
  app.post('/api/stocks/:symbol/distill-refresh', async (req, res, next) => {
    req.setTimeout(5 * 60 * 1000);
    res.setTimeout(5 * 60 * 1000);
    try {
      const symbol = req.params.symbol.toUpperCase();
      if (!cfg.distillApiKey) {
        res.status(400).json({ error: 'Distill not configured — set DISTILL_API_KEY in .env.' });
        return;
      }

      // Entity resolution wants every identifier we hold — the ISIN pins a
      // ticker collision that a symbol search alone would leave ambiguous.
      // Lax read: a stale financials file still carries a valid ISIN/name.
      const cachedFinancials = readJsonEntry<StockFinancials>(
        join(symbolDir(cacheDir, symbol), 'financials.json'),
      ).data;

      const result = await refreshDistillBriefing(
        cacheDir,
        distillHintsFor(symbol, cachedFinancials),
        cfg.distillApiKey,
        cfg.distillApiUrl,
        cfg.distillBriefingTypeId,
      );

      // Single-briefing model: just replace the cached briefing with whatever
      // /refresh returned. On empty-pool (briefing === null) keep the prior
      // briefing — losing established context to a transient upstream miss
      // would degrade the LLM prompt for no good reason.
      const prior = readDistill(cacheDir, symbol);
      const merged: DistillBundle = {
        ticker:    symbol,
        baseUrl:   cfg.distillApiUrl,
        entity:    result.entity,
        briefing:  result.briefing ?? prior?.briefing ?? null,
        fetchedAt: new Date().toISOString(),
        lastRefresh: {
          cacheState:     result.cacheState,
          distillCostUsd: result.distillCostUsd,
          refreshedAt:    result.refreshedAt,
        },
      };
      writeDistill(cacheDir, symbol, merged);

      res.json({
        ok:           true,
        symbol,
        cacheState:   result.cacheState,
        distillCostUsd: result.distillCostUsd,
        bundle:       merged,
      });
    } catch (e) {
      if (e instanceof DistillReadOnlyError) {
        res.status(403).json({ error: 'distill_read_only', message: e.message });
        return;
      }
      if (e instanceof DistillUnauthorizedError) {
        res.status(401).json({ error: 'distill_unauthorized', message: e.message });
        return;
      }
      if (e instanceof DistillAmbiguousTypeError) {
        res.status(422).json({ error: 'distill_ambiguous_type', message: e.message });
        return;
      }
      // The symbol maps to no single entity. 409 rather than 404: the request
      // is well-formed, the registry just needs a human to disambiguate — so
      // ship the candidates instead of a dead end.
      if (e instanceof DistillEntityUnresolvedError) {
        res.status(409).json({
          error:        'distill_entity_unresolved',
          reason:       e.reason,
          message:      e.message,
          entityStatus: e.entityStatus,
          candidates:   e.candidates.map((c) => ({
            id:            c.id,
            ref:           c.ref,
            displayName:   c.displayName,
            matchedOn:     c.matchedOn,
            matchedValue:  c.matchedValue,
            primarySymbol: c.primarySymbol,
            country:       c.country,
            isin:          c.isin,
          })),
        });
        return;
      }
      next(e);
    }
  });

  // ── DELETE /api/stocks/:symbol ─────────────────────────────────────────────
  // Removes the entire cache directory for a symbol (financials, analyses,
  // market signals, news, perplexity, reports). Use with care.
  app.delete('/api/stocks/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const dir = symbolDir(cacheDir, symbol);
    if (!existsSync(dir)) {
      res.status(404).json({ error: `No cached data for ${symbol}` });
      return;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      logger.info(`Deleted cache for ${symbol}`);
      res.json({ ok: true, symbol });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/models ────────────────────────────────────────────────────────
  // List built-in shortcuts + every model id seen in the analysis cache.
  app.get('/api/models', (_req, res) => {
    const symbols = listCachedSymbols(cacheDir);
    const usage = new Map<string, number>();
    for (const sym of symbols) {
      for (const a of listAnalyses(cacheDir, sym)) {
        usage.set(a.flags.model, (usage.get(a.flags.model) ?? 0) + 1);
      }
    }
    const used = Array.from(usage.entries())
      .map(([modelId, count]) => ({ modelId, count }))
      .sort((a, b) => b.count - a.count);

    res.json({
      shortcuts: MODELS.map(({ id, resolved, label }) => ({ id, resolved, label })),
      used,
    });
  });

  // ── GET /api/stocks/:symbol ────────────────────────────────────────────────
  // Shared data + computed metrics. Cheap (<10ms) to recompute on every call.
  app.get('/api/stocks/:symbol', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const dir = symbolDir(cacheDir, symbol);
      if (!existsSync(dir)) {
        res.status(404).json({ error: `No cached data for ${symbol}` });
        return;
      }
      const fRead   = readJsonEntry<StockFinancials>(join(dir, 'financials.json'), FINANCIALS_VERSION);
      const financials = fRead.data;
      if (!financials) {
        // truly missing — only true 404 case
        res.status(404).json({ error: `No financials cached for ${symbol} yet` });
        return;
      }
      const msRead       = readJsonEntry<MarketSignals>(join(dir, 'market-signals.json'), MARKET_SIGNALS_VERSION);
      const newsRead     = readJsonEntry<NewsItem[]>(join(dir, 'news.json'));
      const pplxRead     = readJsonEntry<PerplexityContext>(join(dir, 'perplexity.json'));
      // Distill briefings — lax read (any cached blob; staleness is upstream).
      // The UI renders whatever's on disk and lets the user trigger a refresh
      // via the standard Refresh-data button if they want the newest set.
      const distillRead  = readJsonEntry<DistillBundle>(join(dir, 'distill.json'));
      const marketSignals = msRead.data;
      const news          = newsRead.data ?? [];
      const perplexity    = pplxRead.data;
      const distill       = distillRead.data;
      const summary       = buildStockSummary(cacheDir, symbol);

      // Try to fetch fresh rates + sector medians for richer metrics, but don't block
      // on failure — fall back to defaults so the response always succeeds.
      const [marketRates, sectorMedians] = await Promise.all([
        cfg.fredApiKey ? getMarketRates(cfg.fredApiKey).catch(() => null) : Promise.resolve(null),
        cfg.finnhubApiKey ? getSectorMedians(symbol, cfg.finnhubApiKey).catch(() => null) : Promise.resolve(null),
      ]);

      const metrics = computeAllMetrics(financials, marketRates, sectorMedians);

      // Derive TradingView-style buy/sell aggregate from technicals + price.
      const technicalSignals = marketSignals?.technicals
        ? deriveTechnicalSignals(marketSignals.technicals, financials.price)
        : null;

      // ── Cache freshness summary for the UI's "stale data" banner ────────
      // financials.cachedAt comes from the file mtime; LLM analyses know their
      // own generatedAt. If the most-recent analysis was generated before the
      // most recent data refresh, it's "based on older data".
      const financialsMtime = safeMtime(join(dir, 'financials.json')) ?? Date.now();
      const newestAnalysis  = listAnalyses(cacheDir, symbol)
        .map((a) => new Date(a.generatedAt).getTime())
        .sort((a, b) => b - a)[0];
      const cacheStatus = {
        financials:    fRead.stale ? 'stale' : 'fresh',
        marketSignals: !msRead.data ? 'missing' : msRead.stale ? 'stale' : 'fresh',
        // 'older-than-data' means financials were refreshed AFTER the analysis ran.
        analysis: newestAnalysis === undefined
          ? 'missing'
          : newestAnalysis < financialsMtime - 60_000  // 60s tolerance
            ? 'older-than-data'
            : 'fresh',
      };

      res.json({
        summary,
        financials,
        marketSignals,
        news,
        perplexity,
        distill,
        metrics,
        sectorMedians,
        marketRates,
        technicalSignals,
        cacheStatus,
      });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol/analyses ───────────────────────────────────────
  // List all cached LLM-analysis combinations. Each entry is augmented with
  // `olderThanData`: true when the cached LLM result was generated BEFORE the
  // most recent data refresh (financials.json mtime). The frontend uses this
  // to render a warning marker so the user can still pick the entry — the
  // detail view's StaleBanner takes over from there.
  app.get('/api/stocks/:symbol/analyses', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const entries = listAnalyses(cacheDir, symbol);
    const financialsFile = join(symbolDir(cacheDir, symbol), 'financials.json');
    const financialsMtime = safeMtime(financialsFile) ?? 0;
    const augmented = entries.map((e) => ({
      ...e,
      olderThanData: financialsMtime > 0
        && new Date(e.generatedAt).getTime() < financialsMtime - 60_000,  // 60s tolerance
    }));
    res.json({ symbol, analyses: augmented });
  });

  // ── GET /api/stocks/:symbol/analyses/:hash ─────────────────────────────────
  // Specific cached analysis by hash
  app.get('/api/stocks/:symbol/analyses/:hash', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const hash   = req.params.hash;
    const entries = listAnalyses(cacheDir, symbol);
    const target  = entries.find((e) => e.hash === hash);
    if (!target) {
      res.status(404).json({ error: `No cached analysis ${hash} for ${symbol}` });
      return;
    }
    const cached = readAnalysis(cacheDir, symbol, target.flags);
    if (!cached) {
      res.status(404).json({ error: `Analysis missing or schema-incompatible` });
      return;
    }
    res.json(cached);
  });

  // ── DELETE /api/stocks/:symbol/analyses/:hash ──────────────────────────────
  app.delete('/api/stocks/:symbol/analyses/:hash', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const hash   = req.params.hash;
    const file = join(symbolDir(cacheDir, symbol), 'analyses', `${hash}.json`);
    if (!existsSync(file)) {
      res.status(404).json({ error: `Cached analysis ${hash} not found for ${symbol}` });
      return;
    }
    try {
      unlinkSync(file);
      logger.info(`Deleted analysis ${hash} for ${symbol}`);
      res.json({ ok: true, symbol, hash });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/stocks/:symbol/analyses/by-flags?model=...&search=...&pplx=... ─
  // Look up by flag combination instead of hash
  app.get('/api/stocks/:symbol/analyses-by-flags', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const flags: AnalysisFlagsKey = {
      model:  String(req.query.model ?? ''),
      search: String(req.query.search ?? 'none'),
      pplx:   (req.query.pplx === 'sonar' || req.query.pplx === 'sonar-pro')
        ? req.query.pplx
        : null,
    };
    if (!flags.model) {
      res.status(400).json({ error: 'model query parameter is required' });
      return;
    }
    const cached = readAnalysis(cacheDir, symbol, flags);
    if (!cached) {
      res.status(404).json({
        error: 'Not cached',
        flags,
        hash: analysisHash(flags),
      });
      return;
    }
    res.json(cached);
  });

  // ── POST /api/analyze ──────────────────────────────────────────────────────
  // Trigger a new analysis. Body: { input, model, search, pplx }
  // `search` accepts: single string | comma-separated string | array of strings.
  app.post('/api/analyze', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { input, model, search, pplx, force } = req.body as {
        input?: string; model?: string; search?: string | string[];
        pplx?: 'sonar' | 'sonar-pro' | null;
        force?: boolean;
      };
      if (!input || typeof input !== 'string') {
        res.status(400).json({ error: '`input` (symbol or query string) required' });
        return;
      }

      const isSymbol = looksLikeSymbol(input);
      const opts = isSymbol ? { symbol: input.toUpperCase() } : { query: input };
      logger.info(`Analyze ${isSymbol ? 'symbol' : 'query'}=${input} model=${model ?? 'claude'} search=${JSON.stringify(search ?? 'none')} pplx=${pplx ?? 'none'}${force ? ' force=true' : ''}`);

      const { result, meta } = await runAnalysis({
        ...opts,
        model:   model ?? 'claude',
        search:  search ?? 'none',
        pplx:    pplx ?? null,
        force:   !!force,
        verbose: false,
      });
      res.json({ result, meta });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/analyze/stream ────────────────────────────────────────────────
  // Server-Sent Events stream of analysis progress. Query params:
  //   input, model, search, pplx
  // Events: progress, result, error, done
  app.get('/api/analyze/stream', async (req: Request, res: Response) => {
    const input  = String(req.query.input ?? '');
    const model  = String(req.query.model ?? 'claude');
    // search query param can be repeated (?search=brave&search=tavily) or comma-joined.
    const rawSearch = req.query.search;
    const search: string[] = Array.isArray(rawSearch)
      ? rawSearch.map(String)
      : rawSearch ? String(rawSearch).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const pplxQ  = String(req.query.pplx ?? '');
    const pplx: 'sonar' | 'sonar-pro' | null =
      pplxQ === 'sonar' || pplxQ === 'sonar-pro' ? pplxQ : null;
    const force  = req.query.force === '1' || req.query.force === 'true';

    if (!input) {
      res.status(400).json({ error: '`input` query param required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Heartbeat every 15s so dev-server proxies don't time out.
    const heartbeat = setInterval(() => res.write(': hb\n\n'), 15_000);

    let closed = false;
    req.on('close', () => { closed = true; clearInterval(heartbeat); });

    try {
      const isSymbol = looksLikeSymbol(input);
      const opts = isSymbol ? { symbol: input.toUpperCase() } : { query: input };
      send('progress', { stage: 'init', message: 'Starting analysis…' });

      const { result, meta } = await runAnalysis({
        ...opts,
        model, search, pplx,
        force,
        verbose: false,
        onProgress: (ev) => {
          if (closed) return;
          send('progress', ev);
        },
      });

      if (!closed) {
        send('result', { result, meta });
        send('done', { ok: true });
      }
    } catch (e) {
      if (!closed) send('error', { message: (e as Error).message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  // ── GET /api/stocks/:symbol/report.pdf ─────────────────────────────────────
  // Serve the saved PDF (regenerated each analysis run); 404 if not yet built.
  app.get('/api/stocks/:symbol/report.pdf', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const pdfPath = join(symbolDir(cacheDir, symbol), 'report.pdf');
    if (!existsSync(pdfPath)) {
      res.status(404).json({ error: `No PDF cached for ${symbol} — run an analysis first.` });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${symbol}.pdf"`);
    res.sendFile(pdfPath);
  });

  // ── GET /api/stocks/:symbol/report.md ──────────────────────────────────────
  app.get('/api/stocks/:symbol/report.md', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const mdPath = join(symbolDir(cacheDir, symbol), 'report.md');
    if (!existsSync(mdPath)) {
      res.status(404).json({ error: `No report.md cached for ${symbol}` });
      return;
    }
    res.setHeader('Content-Type', 'text/markdown');
    res.send(readFileSync(mdPath, 'utf-8'));
  });

  // ── Static frontend (production build, served only if present) ────────────
  // From src/server.ts (running via tsx), __dirname is .../src; web/dist is ../web/dist.
  // From dist/server.js (compiled), __dirname is .../dist; same relative path.
  const webDist = resolve(__dirname, '..', 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback — any non-API GET serves index.html for client-side routing
    app.get(/^\/(?!api).*/, (_req, res) => {
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  // ── Error handler ──────────────────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(`Server error: ${err.message}`);
    if (process.env.LOG_LEVEL === 'debug') console.error(err.stack);
    res.status(500).json({ error: err.message });
  });

  return app;
}

// ── Start when invoked directly ────────────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith('server.ts') ||
  process.argv[1].endsWith('server.js')
);

if (isMain) {
  const app = createApp();
  app.listen(PORT, () => {
    logger.success(`Stock-CLI server listening on http://localhost:${PORT}`);
    logger.info(`Endpoints:`);
    logger.info(`  GET  /api/stocks                       — list cached symbols`);
    logger.info(`  GET  /api/stocks/:symbol               — financials + market signals`);
    logger.info(`  GET  /api/stocks/:symbol/analyses      — list cached analysis combos`);
    logger.info(`  GET  /api/stocks/:symbol/analyses/:h   — specific analysis`);
    logger.info(`  GET  /api/stocks/:symbol/analyses-by-flags?model=&search=&pplx= — lookup by flags`);
    logger.info(`  POST /api/analyze                      — run analysis (body: {input, model, search, pplx})`);
    logger.info(`  GET  /api/stocks/:symbol/report.pdf    — saved PDF`);
    logger.info(`  GET  /api/stocks/:symbol/report.md     — saved Markdown`);
  });
}
