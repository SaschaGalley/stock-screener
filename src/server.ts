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
} from './cache.js';
import { StockFinancials, MarketSignals, NewsItem, SectorMedians } from './types.js';
import { PerplexityContext } from './data/perplexity.js';
import { getMarketRates } from './data/fred.js';
import { getSectorMedians } from './data/finnhub.js';
import { computeAllMetrics } from './analysis/computeMetrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const PORT = Number(process.env.PORT ?? 4317);

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveCacheRoot(rawDir: string): string {
  if (rawDir.startsWith('~')) return join(homedir(), rawDir.slice(1));
  if (isAbsolute(rawDir)) return rawDir;
  return resolve(process.cwd(), rawDir);
}

function readJsonEntry<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { v?: unknown; data?: T };
    return parsed.data ?? null;
  } catch {
    return null;
  }
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

  const f = readJsonEntry<StockFinancials>(financialsFile);
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
      shortcuts: [
        { id: 'claude', resolved: 'claude-sonnet-4-6',     label: 'Claude Sonnet 4.6'  },
        { id: 'opus',   resolved: 'claude-opus-4-7',       label: 'Claude Opus 4.7'    },
        { id: 'haiku',  resolved: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
        { id: 'openai', resolved: 'gpt-5.4-mini',          label: 'GPT default'        },
        { id: 'gemini', resolved: 'gemini-1.5-pro',        label: 'Gemini 1.5 Pro'     },
      ],
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
      const financials = readJsonEntry<StockFinancials>(join(dir, 'financials.json'));
      if (!financials) {
        res.status(404).json({ error: `No financials cached for ${symbol}` });
        return;
      }
      const marketSignals = readJsonEntry<MarketSignals>(join(dir, 'market-signals.json'));
      const news          = readJsonEntry<NewsItem[]>(join(dir, 'news.json')) ?? [];
      const perplexity    = readJsonEntry<PerplexityContext>(join(dir, 'perplexity.json'));
      const summary       = buildStockSummary(cacheDir, symbol);

      // Try to fetch fresh rates + sector medians for richer metrics, but don't block
      // on failure — fall back to defaults so the response always succeeds.
      const [marketRates, sectorMedians] = await Promise.all([
        cfg.fredApiKey ? getMarketRates(cfg.fredApiKey).catch(() => null) : Promise.resolve(null),
        cfg.finnhubApiKey ? getSectorMedians(symbol, cfg.finnhubApiKey).catch(() => null) : Promise.resolve(null),
      ]);

      const metrics = computeAllMetrics(financials, marketRates, sectorMedians);

      res.json({
        summary,
        financials,
        marketSignals,
        news,
        perplexity,
        metrics,
        sectorMedians,
        marketRates,
      });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol/analyses ───────────────────────────────────────
  // List all cached LLM-analysis combinations
  app.get('/api/stocks/:symbol/analyses', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const entries = listAnalyses(cacheDir, symbol);
    res.json({ symbol, analyses: entries });
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
      res.status(404).json({ error: `Analysis expired or missing` });
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
  // Trigger a new analysis. Body: { input, model, search, pplx, force? }
  // input is auto-detected as symbol vs query.
  app.post('/api/analyze', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { input, model, search, pplx } = req.body as {
        input?: string; model?: string; search?: string;
        pplx?: 'sonar' | 'sonar-pro' | null;
      };
      if (!input || typeof input !== 'string') {
        res.status(400).json({ error: '`input` (symbol or query string) required' });
        return;
      }

      const isSymbol = looksLikeSymbol(input);
      const opts = isSymbol ? { symbol: input.toUpperCase() } : { query: input };
      logger.info(`Analyze ${isSymbol ? 'symbol' : 'query'}=${input} model=${model ?? 'claude'} search=${search ?? 'none'} pplx=${pplx ?? 'none'}`);

      const { result, meta } = await runAnalysis({
        ...opts,
        model:   model ?? 'claude',
        search:  search ?? 'none',
        pplx:    pplx ?? null,
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
    const search = String(req.query.search ?? 'none');
    const pplxQ  = String(req.query.pplx ?? '');
    const pplx: 'sonar' | 'sonar-pro' | null =
      pplxQ === 'sonar' || pplxQ === 'sonar-pro' ? pplxQ : null;

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
