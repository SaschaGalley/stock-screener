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
  listCachedSymbols,
  readAnalysis,
  readHistory,
  AnalysisFlagsKey,
  analysisHash,
  readDistill,
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
import { distillHintsFor, syncDistillBriefing } from './distill-service.js';
import { getMarketRates } from './data/fred.js';
import { getSectorMediansCached } from './sector-medians.js';
import { computeAllMetrics } from './analysis/computeMetrics.js';
import { deriveTechnicalSignals } from './analysis/signals.js';
import { refreshStockData } from './refresh.js';
import { searchByQuery } from './data/yfinance.js';
import { AppConfigSchema, readAppConfig, writeAppConfig, isWatched } from './app-config.js';
import {
  applySchedule,
  getSchedulerStatus,
  isPipelineRunning,
  requestStop,
  runPipeline,
} from './scheduler.js';
import { HistoryPoint, latestVerdict } from './history.js';

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

// ── Overview rows ────────────────────────────────────────────────────────────

/** One line of the ranked overview table. */
interface OverviewRow {
  symbol:        string;
  companyName:   string;
  sector:        string | null;
  logoDomain:    string | null;
  price:         number | null;
  marketCap:     number | null;
  currency:      string | null;
  /** Newest LLM verdict across all flag combinations. */
  aiScore:        number | null;
  recommendation: string | null;
  verdictAt:      string | null;
  verdictModel:   string | null;
  fairValueEstimate: string | null;
  /** Analyst consensus target and its distance from today's price. */
  targetMean:      number | null;
  targetUpsidePct: number | null;
  /** Composite (primary tier) fair value and its distance from today's price. */
  compositeFairValue: number | null;
  compositeUpsidePct: number | null;
  /** Verdict-score series for the sparkline, oldest first. */
  scoreHistory:  { at: string; score: number }[];
  /** Score change from the first recorded verdict to the newest. */
  scoreDelta:    number | null;
  analysisCount: number;
  dataAgeHours:  number | null;
  watched:       boolean;
}

function pctChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/**
 * Composite fair value, or null when the models can't run.
 *
 * The overview walks every cached symbol, including ones whose financials.json
 * predates the current schema and is missing fields the models dereference. A
 * row without a fair value is still a useful row, so a throw here costs that
 * one number rather than the whole table.
 */
function safeComposite(
  f: StockFinancials,
  marketRates: Awaited<ReturnType<typeof getMarketRates>> | null,
  symbol: string,
): number | null {
  try {
    return computeAllMetrics(f, marketRates, null).composite.primary.median ?? null;
  } catch (e) {
    logger.debug(`Overview: composite unavailable for ${symbol} (${(e as Error).message}) — stale financials schema?`);
    return null;
  }
}

/**
 * Compose one row from what is already on disk.
 *
 * Composite fair value comes from the newest history point when there is one:
 * that value was computed with peer medians in hand, whereas recomputing it
 * here for every row would mean one Finnhub call per stock. The *upside* is
 * always recomputed against today's price, so a fair value recorded last night
 * is not paired with last night's price.
 */
function buildOverviewRow(
  cacheDir: string,
  symbol: string,
  marketRates: Awaited<ReturnType<typeof getMarketRates>> | null,
  watched: boolean,
): OverviewRow | null {
  const dir = symbolDir(cacheDir, symbol);
  const financialsFile = join(dir, 'financials.json');
  const { data: f } = readJsonEntry<StockFinancials>(financialsFile);
  if (!f) return null;

  const analyses = listAnalyses(cacheDir, symbol);
  const newest = [...analyses].sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
  )[0];
  const verdict = newest ? readAnalysis(cacheDir, symbol, newest.flags) : null;

  const history: HistoryPoint[] = readHistory(cacheDir, symbol);
  const scoreHistory = history
    .filter((p) => p.aiScore !== null)
    .map((p) => ({ at: p.at, score: p.aiScore as number }));

  const price = typeof f.price === 'number' ? f.price : null;
  const recorded = [...history].reverse().find((p) => p.compositeFairValue !== null) ?? null;
  const compositeFairValue = recorded?.compositeFairValue ?? safeComposite(f, marketRates, symbol);

  // Prefer the live verdict for the headline score; fall back to history for
  // installs whose analyses predate this file.
  const aiScore = verdict?.llmAnalysis.score
    ?? (scoreHistory.length > 0 ? scoreHistory[scoreHistory.length - 1].score : null);

  const mtime = safeMtime(financialsFile);

  return {
    symbol,
    companyName: f.companyName ?? symbol,
    sector:      f.sector ?? null,
    logoDomain:  logoDomainFromWebsite(f.website ?? null),
    price,
    marketCap:   typeof f.marketCap === 'number' ? f.marketCap : null,
    currency:    f.tradingCurrency ?? null,
    aiScore:        aiScore ?? null,
    recommendation: verdict?.llmAnalysis.recommendation ?? null,
    verdictAt:      newest?.generatedAt ?? null,
    verdictModel:   newest?.flags.model ?? null,
    fairValueEstimate: verdict?.llmAnalysis.fairValueEstimate ?? null,
    targetMean:      typeof f.targetMeanPrice === 'number' ? f.targetMeanPrice : null,
    targetUpsidePct: pctChange(price, typeof f.targetMeanPrice === 'number' ? f.targetMeanPrice : null),
    compositeFairValue,
    compositeUpsidePct: pctChange(price, compositeFairValue),
    scoreHistory,
    scoreDelta: scoreHistory.length >= 2
      ? scoreHistory[scoreHistory.length - 1].score - scoreHistory[0].score
      : null,
    analysisCount: analyses.length,
    dataAgeHours:  mtime === null ? null : (Date.now() - mtime) / 3_600_000,
    watched,
  };
}

/** Score descending; stocks without a verdict sort to the bottom, then A→Z. */
function compareOverviewRows(a: OverviewRow, b: OverviewRow): number {
  if (a.aiScore === null && b.aiScore === null) return a.symbol.localeCompare(b.symbol);
  if (a.aiScore === null) return 1;
  if (b.aiScore === null) return -1;
  if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;
  return a.symbol.localeCompare(b.symbol);
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

  // ── POST /api/stocks ───────────────────────────────────────────────────────
  // Add a stock without analysing it: resolve the input to a ticker, fetch the
  // data layer, done. Adding and analysing are separate decisions — the first
  // is free and fast, the second costs an LLM call, so the UI must not be able
  // to trigger the second by doing the first.
  app.post('/api/stocks', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { input } = req.body as { input?: string };
      if (!input || typeof input !== 'string' || !input.trim()) {
        res.status(400).json({ error: '`input` (symbol or company name) required' });
        return;
      }
      const raw = input.trim();

      // A company name has to go through Yahoo's search first; a ticker-shaped
      // input is handed straight to the refresh, which resolves it anyway.
      const symbol = looksLikeSymbol(raw) ? raw.toUpperCase() : await searchByQuery(raw);
      logger.info(`Add stock: "${raw}" → ${symbol}`);

      const data = await refreshStockData(symbol);
      res.status(201).json({
        ok:      true,
        symbol:  data.symbol,
        summary: buildStockSummary(cacheDir, data.symbol),
      });
    } catch (e) {
      next(e);
    }
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

      // Same merge-and-persist path the nightly job takes (an empty pool keeps
      // the briefing already on disk), so both routes can never drift apart.
      const result = await syncDistillBriefing(
        cacheDir,
        distillHintsFor(symbol, cachedFinancials),
        cfg.distillApiKey,
        cfg.distillApiUrl,
        cfg.distillBriefingTypeId,
        'refresh',
      );

      res.json({
        ok:             true,
        symbol,
        cacheState:     result.cacheState,
        distillCostUsd: result.distillCostUsd,
        bundle:         result.bundle,
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
      models: MODELS.map(({ id, label, provider }) => ({ id, label, provider })),
      used,
    });
  });

  // ── GET /api/health ────────────────────────────────────────────────────────
  // Liveness for the container platform. Deliberately does no I/O beyond
  // reading the process clock: a probe that touches the cache or an upstream
  // API turns a slow disk or a flaky third party into a restart loop.
  app.get('/api/health', (_req, res) => {
    res.json({
      ok:        true,
      uptimeSec: Math.round(process.uptime()),
      scheduler: { running: isPipelineRunning() },
    });
  });

  // ── GET /api/config ────────────────────────────────────────────────────────
  // Operational settings plus the read-only facts the admin page needs to make
  // sense of them: which API keys the process actually has, and which symbols
  // exist to be watched. Key *values* never leave the server.
  app.get('/api/config', (_req, res) => {
    const config = readAppConfig(cacheDir);
    const symbols = listCachedSymbols(cacheDir).sort();
    res.json({
      config,
      symbols: symbols.map((symbol) => ({
        symbol,
        watched: isWatched(config, symbol),
        companyName: readJsonEntry<StockFinancials>(join(symbolDir(cacheDir, symbol), 'financials.json'))
          .data?.companyName ?? symbol,
      })),
      keys: {
        anthropic:  !!cfg.anthropicApiKey,
        openai:     !!cfg.openaiApiKey,
        finnhub:    !!cfg.finnhubApiKey,
        fred:       !!cfg.fredApiKey,
        perplexity: !!cfg.pplxApiKey,
        brave:      !!cfg.braveApiKey,
        tavily:     !!cfg.tavilyApiKey,
        distill:    !!cfg.distillApiKey,
      },
      cacheDir,
      distillApiUrl: cfg.distillApiUrl,
    });
  });

  // ── PUT /api/config ────────────────────────────────────────────────────────
  // Whole-object write (the admin page always sends the full config), then the
  // cron is reinstalled so a schedule change takes effect without a restart.
  app.put('/api/config', (req, res) => {
    const parsed = AppConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_config',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const config = writeAppConfig(cacheDir, parsed.data);
    applySchedule(cacheDir);
    res.json({ ok: true, config, scheduler: getSchedulerStatus(cacheDir) });
  });

  // ── GET /api/jobs ──────────────────────────────────────────────────────────
  app.get('/api/jobs', (_req, res) => {
    res.json(getSchedulerStatus(cacheDir));
  });

  // ── POST /api/jobs/run ─────────────────────────────────────────────────────
  // Fire-and-poll: a full watchlist pass runs for minutes to hours, far past
  // any sane HTTP timeout, so this returns as soon as the run is claimed and
  // the client watches GET /api/jobs for progress.
  app.post('/api/jobs/run', (req, res) => {
    if (isPipelineRunning()) {
      res.status(409).json({ error: 'job_running', message: 'A pipeline run is already in progress.' });
      return;
    }
    const body = req.body as { symbols?: unknown };
    const symbols = Array.isArray(body?.symbols)
      ? body.symbols.filter((s): s is string => typeof s === 'string')
      : undefined;

    runPipeline({ trigger: 'manual', symbols }).catch((e) => {
      logger.error(`Manual run failed: ${(e as Error).message}`);
    });
    res.status(202).json({ ok: true, started: true, symbols: symbols ?? null });
  });

  // ── POST /api/jobs/stop ────────────────────────────────────────────────────
  app.post('/api/jobs/stop', (_req, res) => {
    const stopping = requestStop();
    res.json({ ok: true, stopping });
  });

  // ── GET /api/overview ──────────────────────────────────────────────────────
  // One row per cached stock, ranked by AI verdict score. Everything is read
  // from disk and recomputed in-process; the single upstream call is one FRED
  // fetch for the whole table (the models need a discount rate), and it degrades
  // to null rather than failing the page.
  app.get('/api/overview', async (_req, res, next) => {
    try {
      const config = readAppConfig(cacheDir);
      const marketRates = cfg.fredApiKey ? await getMarketRates(cfg.fredApiKey).catch(() => null) : null;
      const rows = listCachedSymbols(cacheDir)
        .map((symbol) => {
          try {
            return buildOverviewRow(cacheDir, symbol, marketRates, isWatched(config, symbol));
          } catch (e) {
            // One unreadable symbol directory must not blank the whole table.
            logger.warn(`Overview: skipping ${symbol} — ${(e as Error).message}`);
            return null;
          }
        })
        .filter((r): r is OverviewRow => r !== null)
        .sort(compareOverviewRows);
      res.json({ rows });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol/history ────────────────────────────────────────
  app.get('/api/stocks/:symbol/history', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    res.json({ symbol, points: readHistory(cacheDir, symbol) });
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
        getSectorMediansCached(cacheDir, symbol, cfg.finnhubApiKey),
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
    logger.info(`  GET  /api/health                       — liveness probe`);
    logger.info(`  GET  /api/stocks                       — list cached symbols`);
    logger.info(`  GET  /api/overview                     — ranked overview rows`);
    logger.info(`  GET  /api/stocks/:symbol               — financials + market signals`);
    logger.info(`  GET  /api/stocks/:symbol/history       — recorded score/target series`);
    logger.info(`  GET  /api/stocks/:symbol/analyses      — list cached analysis combos`);
    logger.info(`  GET  /api/stocks/:symbol/analyses/:h   — specific analysis`);
    logger.info(`  GET  /api/stocks/:symbol/analyses-by-flags?model=&search=&pplx= — lookup by flags`);
    logger.info(`  POST /api/analyze                      — run analysis (body: {input, model, search, pplx})`);
    logger.info(`  GET  /api/config · PUT /api/config     — operational settings`);
    logger.info(`  GET  /api/jobs · POST /api/jobs/run    — pipeline status / manual run`);
    logger.info(`  GET  /api/stocks/:symbol/report.pdf    — saved PDF`);
    logger.info(`  GET  /api/stocks/:symbol/report.md     — saved Markdown`);

    // Install the cron only once the port is bound: if the process is going to
    // die on EADDRINUSE, it should do so without having kicked off a run.
    applySchedule(getConfig().cacheDir);
  });
}
