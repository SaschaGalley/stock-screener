import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { getConfig } from './config.js';
import { logger } from './utils/logger.js';
import { isHatchetConfigured } from './hatchet/client.js';
import { runAnalysis } from './cli.js';
import {
  AnalysisFlagsKey, analysisHash,
  deleteAnalysis, deleteSymbol, latestSnapshotForAll, latestValueForAll,
  latestDocument, listAnalyses, listDocuments, listMetrics, listSymbols,
  readAnalysis, readDistillLax, readFinancialsMeta, readFinancialsLax,
  readFundamentals, readMarketSignalsMeta, readNewsLax, readPerplexityLax,
  readSeries, seriesForAll, latestVerdictsForAll, CachedAnalysisEntry,
} from './db/store.js';
import { migrate } from './db/migrate.js';
import { syncCatalog } from './db/catalog.js';
import { closePool, waitForDatabase } from './db/client.js';
import { StockFinancials } from './types.js';
import type { AnalysisListEntry, ConsensusBand, OverviewRow, StockSummary } from './api-types.js';
import { MODELS } from './models.js';
import {
  DistillUnauthorizedError,
  DistillEntityUnresolvedError,
} from './data/distill.js';
import { distillHintsFor } from './distill-service.js';
import { syncDistillDossiers } from './distill-content.js';
import { dossiersFollowStocks, noteDossierIntent, watchlistDelta } from './distill-dossiers.js';
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
  JobBusyError,
  recoverInterruptedRuns,
  requestStop,
  stopHatchetRun,
  startPipeline,
} from './scheduler.js';
import { reportExists, reportPath, symbolDir } from './files.js';
import { pctChange } from './utils/num.js';
import { looksLikeSymbol, SAFE_SYMBOL_RE } from './symbols.js';
import { recommendationVote } from './verdict.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const PORT = Number(process.env.PORT ?? 4317);

/** Metric keys the overview reads directly. Named once so the two uses agree. */
const KEY_VERDICT_SCORE = 'verdict.score';
const KEY_COMPOSITE     = 'metrics.composite.primary.median';

// ── Helpers ──────────────────────────────────────────────────────────────────

function logoDomainFromWebsite(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Combined buy/hold/sell band from stored verdicts plus Yahoo's analyst counts.
 * Takes the verdicts as an argument rather than fetching them: both callers
 * already hold the whole map, and re-reading per symbol is what made this the
 * slowest part of the old stock list.
 */
function computeConsensus(f: StockFinancials, verdicts: CachedAnalysisEntry[]): ConsensusBand | null {
  let aiBuy = 0, aiHold = 0, aiSell = 0;
  for (const entry of verdicts) {
    const v = recommendationVote(entry.llmAnalysis.recommendation);
    if (v === 'buy')       aiBuy++;
    else if (v === 'sell') aiSell++;
    else                   aiHold++;
  }
  const aiCount = verdicts.length;
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
  const aiW      = aiPresent && analystPresent ? 0.6 : aiPresent ? 1 : 0;
  const analystW = aiPresent && analystPresent ? 0.4 : analystPresent ? 1 : 0;

  const buy  = aiBuyP  * aiW + aBuyP  * analystW;
  const hold = aiHoldP * aiW + aHoldP * analystW;
  const sell = aiSellP * aiW + aSellP * analystW;
  const sum  = buy + hold + sell;
  if (sum === 0) return null;

  return {
    buy:  buy / sum,
    hold: hold / sum,
    sell: sell / sum,
    sources: (aiPresent ? 1 : 0) + (analystPresent ? 1 : 0),
  };
}

function toSummary(
  symbol: string,
  f: StockFinancials,
  capturedAt: string,
  verdicts: CachedAnalysisEntry[],
): StockSummary {
  return {
    symbol,
    companyName:   f.companyName ?? symbol,
    sector:        f.sector ?? null,
    industry:      f.industry ?? null,
    price:         typeof f.price === 'number' ? f.price : null,
    marketCap:     typeof f.marketCap === 'number' ? f.marketCap : null,
    currency:      f.tradingCurrency ?? null,
    website:       f.website ?? null,
    logoDomain:    logoDomainFromWebsite(f.website ?? null),
    cachedAt:      capturedAt,
    analysisCount: verdicts.length,
    consensus:     computeConsensus(f, verdicts),
  };
}

/** Summary for one symbol — the single-stock path, two queries. */
async function buildStockSummary(symbol: string): Promise<StockSummary | null> {
  const snap = await readFinancialsMeta(symbol);
  if (!snap) return null;
  const verdicts = (await latestVerdictsForAll()).get(symbol) ?? [];
  return toSummary(symbol, snap.data, snap.lastSeenAt, verdicts);
}

/**
 * Composite fair value, or null when the models can't run.
 *
 * The overview covers every stored symbol, including ones whose financials
 * predate the current schema and are missing fields the models dereference. A
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

// ── App Setup ────────────────────────────────────────────────────────────────

// The return type is explicit rather than inferred: under pnpm's strict
// node_modules layout, express's own type references a transitive package this
// module has no path to, so the inferred type cannot be named (TS2742).
export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Logging middleware
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.url}`);
    next();
  });

  // ── Route-param validation ────────────────────────────────────────────────
  // :symbol still reaches the filesystem (EDGAR filings, reports), so an
  // implausible ticker is rejected at the boundary; symbolDir() confines to the
  // data root as defence in depth.
  const SAFE_HASH = /^[a-f0-9]{6,64}$/i;
  app.param('symbol', (req, res, next, value) => {
    if (typeof value !== 'string' || !SAFE_SYMBOL_RE.test(value)) {
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
  const dataDir = cfg.dataDir;

  // ── GET /api/stocks ────────────────────────────────────────────────────────
  app.get('/api/stocks', async (_req, res, next) => {
    try {
      const [financials, verdicts] = await Promise.all([
        latestSnapshotForAll<StockFinancials>('financials'),
        latestVerdictsForAll(),
      ]);
      const summaries = [...financials.entries()]
        .map(([symbol, snap]) => toSummary(symbol, snap.data, snap.lastSeenAt, verdicts.get(symbol) ?? []))
        .sort((a, b) => a.companyName.localeCompare(b.companyName));
      res.json({ stocks: summaries });
    } catch (e) {
      next(e);
    }
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

      const { refreshData } = await import('./hatchet/tasks/single.js');
      // The refresh resolves the ticker once more internally and may tidy it,
      // so the response names the stock by what came back rather than by what
      // went in.
      const { symbol: resolved } = await viaHatchet(
        () => refreshData.run({ symbol, includeDistill: true }, interactive({ symbol })),
        async () => {
          const d = await refreshStockData(symbol);
          return { data: d as never, symbol: d.symbol };
        },
      );
      res.status(201).json({
        ok:      true,
        symbol:  resolved,
        summary: await buildStockSummary(resolved),
      });

      // The watchlist just grew, so Distill's dossier switch follows it. After
      // the response and deliberately not awaited: the stock is added either
      // way, and a Distill outage must not hold the request open for the length
      // of a retry budget. `dossiersFollow` records its own failures, and the
      // next run's full sync repairs whatever this misses.
      void (async () => {
        const config = await readAppConfig();
        await dossiersFollowStocks([{ symbol: resolved, enabled: isWatched(config, resolved) }]);
      })().catch((e) => logger.warn(`Distill dossier switch for ${resolved} failed: ${(e as Error).message}`));
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/stocks/:symbol/refresh-data ──────────────────────────────────
  // Force-refresh the data layer (Yahoo + Finnhub + FRED + macro + technicals)
  // for a symbol without touching stored verdicts, Perplexity, or reports.
  app.post('/api/stocks/:symbol/refresh-data', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const { refreshData } = await import('./hatchet/tasks/single.js');
      const out = await viaHatchet(
        () => refreshData.run({ symbol, includeDistill: true }, interactive({ symbol })),
        async () => {
          const d = await refreshStockData(symbol);
          return { data: d as never, symbol: d.symbol };
        },
      );
      res.json({ ok: true, ...out.data });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/stocks/:symbol/distill-refresh ───────────────────────────────
  // Triggers Distill's POST /api/v1/briefings/refresh — runs the upstream
  // distill drain + (re)briefing for this ticker and stores the result.
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
      // Lax read: stale financials still carry a valid ISIN/name.
      const financials = await readFinancialsLax(symbol);

      // Same path the nightly job takes, so the button and the run can never
      // drift apart. Free now: it re-reads the dossiers and the insights they
      // do not reproduce, and buys nothing.
      const { distillRefresh } = await import('./hatchet/tasks/single.js');
      const { result } = await viaHatchet(
        () => distillRefresh.run({ symbol }, interactive({ symbol })),
        async () => ({ result: await syncDistillDossiers(
          distillHintsFor(symbol, financials),
          cfg.distillApiKey!,
          cfg.distillApiUrl,
        ) as never }),
      );

      res.json({
        ok:     true,
        symbol,
        detail: result.detail,
        bundle: result.bundle,
      });
    } catch (e) {
      if (e instanceof DistillUnauthorizedError) {
        res.status(401).json({ error: 'distill_unauthorized', message: e.message });
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
  // Removes the symbol and everything referencing it — snapshots, the whole
  // observation history, documents, filings index — plus its downloaded files.
  // Irreversible in a way the old cache delete was not: history cannot be
  // refetched.
  app.delete('/api/stocks/:symbol', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();

      // Before the delete, not after. The symbol → entity mapping lives in
      // `distill_entities`, which cascades away with the row; copying the id
      // into the dossier ledger first is what lets the off-switch outlive the
      // stock and be retried until Distill confirms it. Writing the intent is
      // one statement — the call itself waits until after the response.
      await noteDossierIntent([{ kind: 'company', subject: symbol, enabled: false }]);

      const removed = await deleteSymbol(symbol);
      if (!removed) {
        res.status(404).json({ error: `No stored data for ${symbol}` });
        return;
      }
      try {
        rmSync(symbolDir(dataDir, symbol), { recursive: true, force: true });
      } catch (e) {
        logger.warn(`Deleted ${symbol} from the database but not its files: ${(e as Error).message}`);
      }
      logger.info(`Deleted ${symbol}`);
      res.json({ ok: true, symbol });

      // Switching off deletes nothing upstream — existing dossiers stand, they
      // just stop being extended — so a stock that comes back keeps its history.
      void dossiersFollowStocks([{ symbol, enabled: false }])
        .catch((e) => logger.warn(`Distill dossier switch for ${symbol} failed: ${(e as Error).message}`));
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/models ────────────────────────────────────────────────────────
  // Built-in shortcuts + every model id that has produced a stored verdict.
  app.get('/api/models', async (_req, res, next) => {
    try {
      const verdicts = await latestVerdictsForAll();
      const usage = new Map<string, number>();
      for (const entries of verdicts.values()) {
        for (const entry of entries) {
          usage.set(entry.flags.model, (usage.get(entry.flags.model) ?? 0) + 1);
        }
      }
      const used = Array.from(usage.entries())
        .map(([modelId, count]) => ({ modelId, count }))
        .sort((a, b) => b.count - a.count);

      res.json({
        models: MODELS.map(({ id, label, provider }) => ({ id, label, provider })),
        used,
      });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/health ────────────────────────────────────────────────────────
  // Liveness for the container platform. Deliberately does no I/O beyond
  // reading the process clock: a probe that touches the database or an upstream
  // API turns a slow disk or a flaky third party into a restart loop.
  app.get('/api/health', (_req, res) => {
    res.json({
      ok:        true,
      uptimeSec: Math.round(process.uptime()),
      // In-process only, deliberately: this probe must not touch the database,
      // and under Hatchet the run lives in the worker. GET /api/jobs is the
      // endpoint that answers "is a pipeline running anywhere".
      scheduler: { running: isPipelineRunning() },
    });
  });

  // ── GET /api/config ────────────────────────────────────────────────────────
  // Operational settings plus the read-only facts the admin page needs to make
  // sense of them: which API keys the process actually has, and which symbols
  // exist to be watched. Key *values* never leave the server.
  app.get('/api/config', async (_req, res, next) => {
    try {
      const [config, financials] = await Promise.all([
        readAppConfig(),
        latestSnapshotForAll<StockFinancials>('financials'),
      ]);
      res.json({
        config,
        symbols: [...financials.entries()]
          .map(([symbol, snap]) => ({
            symbol,
            watched: isWatched(config, symbol),
            companyName: snap.data.companyName ?? symbol,
          }))
          .sort((a, b) => a.symbol.localeCompare(b.symbol)),
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
        dataDir,
        distillApiUrl: cfg.distillApiUrl,
      });
    } catch (e) {
      next(e);
    }
  });

  // ── PUT /api/config ────────────────────────────────────────────────────────
  // Whole-object write (the admin page always sends the full config), then the
  // cron is reinstalled so a schedule change takes effect without a restart.
  app.put('/api/config', async (req, res, next) => {
    try {
      const parsed = AppConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_config',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
      const before = await readAppConfig();
      const config = await writeAppConfig(parsed.data);
      await applySchedule();
      res.json({ ok: true, config, scheduler: await getSchedulerStatus() });

      // Unticking a stock here is the other way it leaves the watchlist, and it
      // costs money for as long as Distill keeps building for it. Only the
      // symbols that actually changed sides are sent.
      void (async () => {
        const changes = await watchlistDelta(before, config);
        await dossiersFollowStocks(changes);
      })().catch((e) => logger.warn(`Distill dossier switch after a config change failed: ${(e as Error).message}`));
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/jobs ──────────────────────────────────────────────────────────
  app.get('/api/jobs', async (_req, res, next) => {
    try {
      res.json(await getSchedulerStatus());
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/jobs/run ─────────────────────────────────────────────────────
  // Fire-and-poll: a full watchlist pass runs for minutes to hours, far past
  // any sane HTTP timeout, so this returns as soon as the run is claimed and
  // the client watches GET /api/jobs for progress.
  app.post('/api/jobs/run', async (req, res) => {
    const body = req.body as { symbols?: unknown };
    const symbols = Array.isArray(body?.symbols)
      ? body.symbols.filter((s): s is string => typeof s === 'string')
      : undefined;

    // Fire-and-poll: `startPipeline` resolves once the run is accepted — the
    // pass itself outlives this request by hours, and the client watches
    // GET /api/jobs for progress.
    try {
      await startPipeline({ trigger: 'manual', symbols });
    } catch (e) {
      if (e instanceof JobBusyError) {
        res.status(409).json({ error: 'job_running', message: e.message });
        return;
      }
      logger.error(`Manual run failed: ${(e as Error).message}`);
      res.status(500).json({ error: 'run_failed', message: (e as Error).message });
      return;
    }
    res.status(202).json({ ok: true, started: true, symbols: symbols ?? null });
  });

  // ── GET /api/activity ──────────────────────────────────────────────────────
  // What is in flight right now, optionally for one symbol. Answered from
  // Hatchet rather than from `runs`/`run_steps`: the queue is the only thing
  // that knows about work which is accepted but not yet started, and mirroring
  // that into Postgres would mean reconciling rows no process ever finished.
  //
  // The history stays where it was. A queue is not an archive.
  app.get('/api/activity', async (req, res, next) => {
    try {
      if (!isHatchetConfigured()) {
        res.json({ hatchet: false, busy: isPipelineRunning(), entries: [] });
        return;
      }
      const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
      const { inFlight, symbolActivity } = await import('./hatchet/activity.js');
      if (symbol) {
        res.json({ hatchet: true, ...(await symbolActivity(symbol)) });
        return;
      }
      const entries = await inFlight();
      res.json({ hatchet: true, busy: entries.length > 0, entries });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/jobs/stop ────────────────────────────────────────────────────
  app.post('/api/jobs/stop', async (_req, res, next) => {
    try {
      // The in-process flag only reaches a run this process is walking; under
      // Hatchet the run is in the worker and has to be cancelled through the
      // queue. Both are tried, since either scheduler may own the run.
      const stopping = requestStop() || await stopHatchetRun();
      res.json({ ok: true, stopping });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/overview ──────────────────────────────────────────────────────
  // One row per stored stock, ranked by verdict score. Four queries for the
  // whole table — the financials, the verdicts, the recorded score series and
  // the recorded composite — plus one FRED fetch for symbols that have never
  // had a composite recorded.
  app.get('/api/overview', async (_req, res, next) => {
    try {
      const [config, financials, verdicts, scoreSeries, composites] = await Promise.all([
        readAppConfig(),
        latestSnapshotForAll<StockFinancials>('financials'),
        latestVerdictsForAll(),
        seriesForAll(KEY_VERDICT_SCORE),
        latestValueForAll(KEY_COMPOSITE),
      ]);
      const marketRates = cfg.fredApiKey ? await getMarketRates(cfg.fredApiKey).catch(() => null) : null;

      const rows: OverviewRow[] = [];
      for (const [symbol, snap] of financials) {
        const f = snap.data;
        const entries = verdicts.get(symbol) ?? [];
        const newest = [...entries].sort(
          (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
        )[0];

        const scoreHistory = (scoreSeries.get(symbol) ?? [])
          .filter((p) => p.value !== null)
          .map((p) => ({ at: p.at, score: p.value as number }));

        const price = typeof f.price === 'number' ? f.price : null;
        // Prefer the recorded composite: it was computed with peer medians in
        // hand, whereas recomputing here would mean a Finnhub call per row. The
        // upside is always recomputed against today's price, so a fair value
        // from last night is never paired with last night's price.
        const compositeFairValue = composites.get(symbol) ?? safeComposite(f, marketRates, symbol);

        const aiScore = newest?.llmAnalysis.score
          ?? (scoreHistory.length > 0 ? scoreHistory[scoreHistory.length - 1].score : null);

        rows.push({
          symbol,
          companyName: f.companyName ?? symbol,
          sector:      f.sector ?? null,
          logoDomain:  logoDomainFromWebsite(f.website ?? null),
          price,
          marketCap:   typeof f.marketCap === 'number' ? f.marketCap : null,
          currency:    f.tradingCurrency ?? null,
          aiScore:        aiScore ?? null,
          recommendation: newest?.llmAnalysis.recommendation ?? null,
          verdictAt:      newest?.generatedAt ?? null,
          verdictModel:   newest?.flags.model ?? null,
          fairValueEstimate: newest?.llmAnalysis.fairValueEstimate ?? null,
          targetMean:      typeof f.targetMeanPrice === 'number' ? f.targetMeanPrice : null,
          targetUpsidePct: pctChange(price, typeof f.targetMeanPrice === 'number' ? f.targetMeanPrice : null),
          compositeFairValue,
          compositeUpsidePct: pctChange(price, compositeFairValue),
          scoreHistory,
          scoreDelta: scoreHistory.length >= 2
            ? scoreHistory[scoreHistory.length - 1].score - scoreHistory[0].score
            : null,
          analysisCount: entries.length,
          dataAgeHours:  (Date.now() - new Date(snap.lastSeenAt).getTime()) / 3_600_000,
          watched:       isWatched(config, symbol),
        });
      }

      // Score descending; stocks without a verdict sort to the bottom, then A→Z.
      rows.sort((a, b) => {
        if (a.aiScore === null && b.aiScore === null) return a.symbol.localeCompare(b.symbol);
        if (a.aiScore === null) return 1;
        if (b.aiScore === null) return -1;
        if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;
        return a.symbol.localeCompare(b.symbol);
      });
      res.json({ rows });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/metrics ───────────────────────────────────────────────────────
  // The catalogue: every series that exists, with label, unit and the
  // description lifted from the zod schema. This is what lets the UI offer a
  // metric picker instead of hard-coding which numbers are chartable.
  app.get('/api/metrics', async (req, res, next) => {
    try {
      const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
      res.json({ metrics: await listMetrics(domain) });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol/series?keys=a,b&from=&to= ──────────────────────
  // Any recorded metric over time. Replaces the old fixed-shape history
  // endpoint: the set of chartable numbers is now a query parameter rather
  // than a decision baked into a TypeScript interface.
  app.get('/api/stocks/:symbol/series', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const keys = String(req.query.keys ?? '')
        .split(',').map((k) => k.trim()).filter(Boolean);
      if (keys.length === 0) {
        res.status(400).json({ error: '`keys` query parameter required (comma-separated metric keys)' });
        return;
      }
      const parseDate = (v: unknown): Date | undefined => {
        if (typeof v !== 'string' || !v) return undefined;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? undefined : d;
      };
      res.json({
        symbol,
        series: await readSeries(symbol, keys, {
          from: parseDate(req.query.from),
          to:   parseDate(req.query.to),
        }),
      });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol/documents/:kind ────────────────────────────────
  // The change history of a text output — Distill briefings, Perplexity
  // syntheses, verdicts, search traces. One row per version that actually
  // differed, which is what makes "what shifted since last month?" answerable.
  app.get('/api/stocks/:symbol/documents/:kind', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const kind = req.params.kind;
      const allowed = ['distill', 'perplexity', 'verdict', 'search_trace'] as const;
      if (!(allowed as readonly string[]).includes(kind)) {
        res.status(400).json({ error: `unknown document kind "${kind}"`, allowed });
        return;
      }
      const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
      const variant = typeof req.query.variant === 'string' ? req.query.variant : undefined;
      res.json({
        symbol, kind,
        documents: await listDocuments(symbol, kind as typeof allowed[number], { limit, variant }),
      });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol/fundamentals?period=annual|quarter|estimate ────
  // Reported figures on their own axis: keyed by fiscal period, carrying the
  // date we observed them so a restatement is visible rather than silent.
  app.get('/api/stocks/:symbol/fundamentals', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const raw = String(req.query.period ?? 'annual');
      if (raw !== 'annual' && raw !== 'quarter' && raw !== 'estimate') {
        res.status(400).json({ error: 'period must be annual, quarter or estimate' });
        return;
      }
      res.json({ symbol, period: raw, rows: await readFundamentals(symbol, raw) });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol ────────────────────────────────────────────────
  // Stored data + computed metrics. Cheap (<10ms) to recompute on every call.
  app.get('/api/stocks/:symbol', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const fSnap = await readFinancialsMeta(symbol);
      if (!fSnap) {
        res.status(404).json({ error: `No financials stored for ${symbol} yet` });
        return;
      }
      const financials = fSnap.data;

      const [msSnap, news, perplexity, distill, summary] = await Promise.all([
        readMarketSignalsMeta(symbol),
        readNewsLax(symbol),
        readPerplexityLax(symbol),
        readDistillLax(symbol),
        buildStockSummary(symbol),
      ]);

      // Try to fetch fresh rates + sector medians for richer metrics, but don't
      // block on failure — fall back to defaults so the response always succeeds.
      const [marketRates, sectorMedians] = await Promise.all([
        cfg.fredApiKey ? getMarketRates(cfg.fredApiKey).catch(() => null) : Promise.resolve(null),
        getSectorMediansCached(symbol, cfg.finnhubApiKey),
      ]);

      const marketSignals = msSnap?.data ?? null;
      const metrics = computeAllMetrics(financials, marketRates, sectorMedians);

      // Derive TradingView-style buy/sell aggregate from technicals + price.
      const technicalSignals = marketSignals?.technicals
        ? deriveTechnicalSignals(marketSignals.technicals, financials.price)
        : null;

      // ── Freshness summary for the UI's "stale data" banner ────────────────
      // If the most recent verdict was produced before the last data refresh,
      // it is "based on older data".
      const analyses = await listAnalyses(symbol);
      const newestAnalysis = analyses
        .map((a) => new Date(a.generatedAt).getTime())
        .sort((a, b) => b - a)[0];
      const dataAt = new Date(fSnap.lastSeenAt).getTime();
      const cacheStatus = {
        financials:    fSnap.stale ? 'stale' : 'fresh',
        marketSignals: !msSnap ? 'missing' : msSnap.stale ? 'stale' : 'fresh',
        analysis: newestAnalysis === undefined
          ? 'missing'
          : newestAnalysis < dataAt - 60_000   // 60s tolerance
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
  // List all stored verdict combinations. Each entry is augmented with
  // `olderThanData`: true when the verdict was produced BEFORE the most recent
  // data refresh. The frontend renders a warning marker so the user can still
  // pick the entry — the detail view's StaleBanner takes over from there.
  app.get('/api/stocks/:symbol/analyses', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const [entries, fSnap] = await Promise.all([
        listAnalyses(symbol),
        readFinancialsMeta(symbol),
      ]);
      const dataAt = fSnap ? new Date(fSnap.lastSeenAt).getTime() : 0;
      const augmented: AnalysisListEntry[] = entries.map((e) => ({
        ...e,
        olderThanData: dataAt > 0 && new Date(e.generatedAt).getTime() < dataAt - 60_000,
      }));
      res.json({ symbol, analyses: augmented });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol/analyses/:hash ─────────────────────────────────
  app.get('/api/stocks/:symbol/analyses/:hash', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const doc = await latestDocument<CachedAnalysisEntry>(symbol, 'verdict', req.params.hash);
      if (!doc?.data) {
        res.status(404).json({ error: `No stored analysis ${req.params.hash} for ${symbol}` });
        return;
      }
      res.json(doc.data);
    } catch (e) {
      next(e);
    }
  });

  // ── DELETE /api/stocks/:symbol/analyses/:hash ──────────────────────────────
  app.delete('/api/stocks/:symbol/analyses/:hash', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const hash   = req.params.hash;
      const removed = await deleteAnalysis(symbol, hash);
      if (!removed) {
        res.status(404).json({ error: `Stored analysis ${hash} not found for ${symbol}` });
        return;
      }
      logger.info(`Deleted analysis ${hash} for ${symbol}`);
      res.json({ ok: true, symbol, hash });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol/analyses-by-flags?model=&search=&pplx= ─────────
  app.get('/api/stocks/:symbol/analyses-by-flags', async (req, res, next) => {
    try {
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
      const stored = await readAnalysis(symbol, flags);
      if (!stored) {
        res.status(404).json({ error: 'Not stored', flags, hash: analysisHash(flags) });
        return;
      }
      res.json(stored);
    } catch (e) {
      next(e);
    }
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

      const { analyze } = await import('./hatchet/tasks/single.js');
      const { result, meta } = await viaHatchet(
        () => analyze.run(
          { input, model, search, pplx, force },
          // Tagged by ticker where there is one; a free-text query has no
          // symbol to file the run under until the analysis resolves it.
          interactive(isSymbol ? { symbol: input.toUpperCase() } : { query: input }),
        ),
        async () => await runAnalysis({
          ...opts,
          model:   model ?? 'claude',
          search:  search ?? 'none',
          pplx:    pplx ?? null,
          force:   !!force,
          verbose: false,
        }) as never,
      );
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

      const { result, meta } = await viaHatchet(
        // Through the queue the analysis runs in the worker, so its progress
        // has to travel back: the task writes each event to the run's stream
        // and this subscribes to it. The events forwarded are the same ones the
        // in-process path emitted, so the client cannot tell the difference.
        async () => {
          const { analyze } = await import('./hatchet/tasks/single.js');
          const { getHatchet } = await import('./hatchet/client.js');
          const ref = await analyze.runNoWait(
            { input, model, search, pplx, force },
            interactive(isSymbol ? { symbol: input.toUpperCase() } : { query: input }),
          );
          // `workflowRunId` resolves to either the id or a wrapper around it,
          // depending on how the run was triggered.
          const resolved = await ref.workflowRunId;
          const runId = typeof resolved === 'string' ? resolved : resolved.workflowRunId;

          // Consumed until the run ends, which is what closes the iterator.
          void (async () => {
            try {
              for await (const chunk of getHatchet().runs.subscribeToStream(runId)) {
                if (closed) return;
                try { send('progress', JSON.parse(chunk)); }
                catch { send('progress', { stage: 'info', message: chunk }); }
              }
            } catch { /* the result below is what decides the outcome */ }
          })();

          return ref.result();
        },
        async () => await runAnalysis({
          ...opts,
          model, search, pplx,
          force,
          verbose: false,
          onProgress: (ev) => {
            if (closed) return;
            send('progress', ev);
          },
        }) as never,
      );

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
  // Reports are one of the two things that stayed files (see src/files.ts).
  app.get('/api/stocks/:symbol/report.pdf', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!reportExists(dataDir, symbol, 'report.pdf')) {
      res.status(404).json({ error: `No PDF stored for ${symbol} — run an analysis first.` });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${symbol}.pdf"`);
    res.sendFile(reportPath(dataDir, symbol, 'report.pdf'));
  });

  // ── GET /api/stocks/:symbol/report.md ──────────────────────────────────────
  app.get('/api/stocks/:symbol/report.md', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!reportExists(dataDir, symbol, 'report.md')) {
      res.status(404).json({ error: `No report.md stored for ${symbol}` });
      return;
    }
    res.setHeader('Content-Type', 'text/markdown');
    res.send(readFileSync(reportPath(dataDir, symbol, 'report.md'), 'utf-8'));
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
    // A missing worker is a deployment state, not a bug in the request: 503
    // so the caller can tell "come back later" from "this will never work".
    if (err.name === 'NoWorkerError') {
      res.status(503).json({ error: 'no_worker', message: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  });

  return app;
}

/**
 * Bring the database up to date before serving.
 *
 * Migrations and the catalogue sync both run on every boot and are both
 * idempotent — the catalogue in particular has to run before anything writes an
 * observation, because it owns the key → id mapping those writes need.
 */
/**
 * How an interactive job is dispatched.
 *
 * The endpoints below still await their result and answer with it, so the web
 * UI is unchanged — what moves is *where* the work happens. In the worker it
 * counts against the same rate limits and the same Distill gate as the nightly
 * pipeline, which is the whole point: a refresh clicked at 2am used to slip
 * past both.
 *
 * Without a token there is no queue to use, so the work runs inline exactly as
 * it always did.
 */
async function viaHatchet<O>(enqueue: () => Promise<O>, inline: () => Promise<O>): Promise<O> {
  if (!isHatchetConfigured()) return inline();

  // Checked first, because the failure without it is the unhelpful kind: the
  // task is accepted, nothing picks it up, and the browser waits on a request
  // that will never answer. Before this work moved to the queue that click
  // simply ran, so an unattended queue must say so rather than hang.
  const { hasActiveWorker } = await import('./hatchet/activity.js');
  if (!await hasActiveWorker()) throw new NoWorkerError();

  return enqueue();
}

/** No worker is listening, so there is no point queueing the work. */
export class NoWorkerError extends Error {
  constructor() {
    super('No Hatchet worker is running — start one with `pnpm hatchet:worker` '
      + '(in production, the stockcli-worker container).');
    this.name = 'NoWorkerError';
  }
}

/**
 * Trigger options for work a person is waiting on.
 *
 * HIGH priority because they are waiting: with Distill serialised, a click
 * during a nightly pass would otherwise queue behind every remaining symbol.
 * Spelled numerically (3 = Priority.HIGH) to keep the SDK's enum out of the
 * server's imports; the value is part of the wire protocol.
 */
const interactive = (meta: Record<string, string>) => ({
  additionalMetadata: { ...meta, trigger: 'api' },
  priority: 3,
});

export async function prepareDatabase(): Promise<void> {
  await waitForDatabase();
  await migrate();
  await syncCatalog();
  await recoverInterruptedRuns();
}

// ── Start when invoked directly ────────────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith('server.ts') ||
  process.argv[1].endsWith('server.js')
);

if (isMain) {
  prepareDatabase()
    .then(() => {
      const app = createApp();
      const server = app.listen(PORT, () => {
        logger.success(`Stock-CLI server listening on http://localhost:${PORT}`);
        logger.info(`Endpoints:`);
        logger.info(`  GET  /api/health                       — liveness probe`);
        logger.info(`  GET  /api/stocks                       — list stored symbols`);
        logger.info(`  GET  /api/overview                     — ranked overview rows`);
        logger.info(`  GET  /api/stocks/:symbol               — financials + market signals`);
        logger.info(`  GET  /api/metrics                      — metric catalogue (chart picker)`);
        logger.info(`  GET  /api/stocks/:symbol/series?keys=  — any recorded metric over time`);
        logger.info(`  GET  /api/stocks/:symbol/documents/:k  — Distill/Perplexity/verdict history`);
        logger.info(`  GET  /api/stocks/:symbol/fundamentals  — reported figures by fiscal period`);
        logger.info(`  GET  /api/stocks/:symbol/analyses      — list stored verdict combos`);
        logger.info(`  POST /api/analyze                      — run analysis (body: {input, model, search, pplx})`);
        logger.info(`  GET  /api/config · PUT /api/config     — operational settings`);
        logger.info(`  GET  /api/jobs · POST /api/jobs/run    — pipeline status / manual run`);
        logger.info(`  GET  /api/activity?symbol=             — what is in flight right now`);

        // Install the cron only once the port is bound: if the process is going
        // to die on EADDRINUSE, it should do so without having kicked off a run.
        applySchedule().catch((e) => logger.error(`Could not install schedule: ${(e as Error).message}`));
      });

      // Close the pool on shutdown so in-flight queries finish and the server
      // doesn't leave connections behind on a redeploy.
      const shutdown = () => {
        server.close(() => { closePool().finally(() => process.exit(0)); });
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((e) => {
      logger.error(`Startup failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
