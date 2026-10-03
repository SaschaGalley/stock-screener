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
  deleteAnalysis, deleteSymbol, latestSnapshotForAll, latestPointsForAll, latestValueForAll, scoreInstants,
  latestDocument, listAnalyses, listDocuments, listMetrics, listSymbols,
  readAnalysis, readDistillLax, readFinancialsMeta, readFinancialsLax,
  readFundamentals, readMarketSignalsMeta, readNewsLax, readPerplexityLax, readDeepResearchLax,
  readSeries, seriesForAll, latestVerdictsForAll, CachedAnalysisEntry, symbolCounts, refreshedWithin,
  recentVerdictChanges, peersByIndustry, peersBySymbol, StoredPeer,
} from './db/store.js';
import { sendAlert, verdictAlert } from './alerts.js';
import { sendDigest } from './digest.js';
import { applyBacktestSchedule, backtestOverview, reconcileBacktestStatus, startBacktest } from './backtest-service.js';
import { storedBacktest } from './backtest/result.js';
import { CALIBRATION_META, calibrationDue } from './analysis/calibration.js';
import { migrate } from './db/migrate.js';
import { storedMembers } from './universe.js';
import { tradingViewLogoUrl } from './data/tradingview-logo.js';
import { syncCatalog } from './db/catalog.js';
import { closePool, waitForDatabase } from './db/client.js';
import { LLMAnalysis, PillarKey, ScoreCard, StockFinancials } from './types.js';
import { PILLAR_LABELS, WEIGHTS } from './analysis/score.js';
import { FITTED_WEIGHTS_META } from './analysis/weight-table.js';
import type {
  AnalysisListEntry, BacktestResponse, ConsensusBand, EvaluationResponse, OverviewRow, PeerRow, PeersResponse,
  StockSummary,
} from './api-types.js';
import { DEFAULT_PERPLEXITY_MODEL, isPerplexityModel, MODELS, PerplexityModelId } from './models.js';
import {
  DistillUnauthorizedError,
  DistillEntityUnresolvedError,
} from './data/distill.js';
import { distillHintsFor } from './distill-service.js';
import { syncDistillDossiers } from './distill-content.js';
import { dossiersFollowStocks, noteDossierIntent, watchlistDelta } from './distill-dossiers.js';
import { getMarketRates } from './data/fred.js';
import { computeAllMetrics } from './analysis/computeMetrics.js';
import { deriveTechnicalSignals } from './analysis/signals.js';
import { cachedEvaluation, EVALUATED_SIGNALS } from './db/evaluate.js';
import { currentScoreCard, rescoreIfScoringChanged, storedInputs } from './db/rescore.js';
import { refreshStockData } from './refresh.js';
import { refreshPerplexity } from './perplexity-service.js';
import { fairRatios, getValuationHistory, sectorMultiples } from './valuation-history-service.js';
import {
  analystCoverage, analystTrackRecord, incomeFlows, stockHolders, stockTimeline, verdictRecordSummary, verdictTrackRecord,
  watchlistFeed,
} from './stock-history-service.js';
import { QuoteBrief, quoteBriefs, searchByQuery } from './data/yfinance.js';
import { yahooTicker } from './data/universe.js';
import { lastGoodSectorMedians } from './sector-medians.js';
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
import { recommendationVote, verdictForScore } from './verdict.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const PORT = Number(process.env.PORT ?? 4317);

/** Metric keys the overview reads directly. Named once so the two uses agree. */
// The headline series is the blended score, which the daily refresh writes for
// every symbol whether or not the analysis step ran. `verdict.score` still
// exists and still charts — it is simply no longer the headline.
const KEY_SCORE         = 'score.final.score';
/** The rest of the card the overview shows, read from the same daily series. */
const KEY_CARD = [
  'score.final.verdict',
  'score.factor.score',
  'score.factor.confidence',
  'score.factor.agreement',
  'score.narrative.score',
] as const;
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
 * How many same-industry companies the peer dialog lists. Most Yahoo industries
 * hold fewer across the list and the universe; the cap is for the few that do
 * not, such as regional banks and utilities.
 */
const INDUSTRY_PEER_LIMIT = 30;

function peerRow(p: StoredPeer): PeerRow {
  return {
    symbol:      p.symbol,
    companyName: p.companyName,
    logoDomain:  logoDomainFromWebsite(p.website),
    price:       p.price,
    marketCap:   p.marketCap,
    currency:    p.currency,
    score:       p.score,
    verdict:     p.verdict,
    status:      p.reference ? 'reference' : 'list',
  };
}

/**
 * One row per company. Alphabet's two share classes are one competitor, and
 * Yahoo gives both lines the same name; so do a stock's other listings in the
 * universe. The row on the list wins over its twin, otherwise the first — the
 * larger, in the order the industry arrives. `taken` names companies already
 * shown elsewhere in the dialog.
 */
function onePerCompany(rows: PeerRow[], taken: (string | null)[]): PeerRow[] {
  const shown = new Set(taken.filter((n): n is string => !!n));
  const byName = new Map<string, number>();
  const out: PeerRow[] = [];
  for (const row of rows) {
    const name = row.companyName;
    if (name && shown.has(name)) continue;
    const at = name ? byName.get(name) : undefined;
    if (at === undefined) {
      if (name) byName.set(name, out.length);
      out.push(row);
    } else if (row.status === 'list' && out[at].status !== 'list') {
      out[at] = row;
    }
  }
  return out;
}

/** A peer the database has never stored: a ticker, and whatever Yahoo's quote says about it. */
function unknownPeerRow(symbol: string, quote: QuoteBrief | undefined): PeerRow {
  return {
    symbol,
    companyName: quote?.name ?? null,
    logoDomain:  null,
    price:       quote?.price ?? null,
    marketCap:   quote?.marketCap ?? null,
    currency:    quote?.currency ?? null,
    score:       null,
    verdict:     null,
    status:      'unknown',
  };
}

/**
 * A stored verdict, with its arithmetic brought up to date.
 *
 * The prose in a stored entry is what a model wrote on the evening it ran, and
 * that is what it should stay. The factor half is not: it is a pure function of
 * data the refresh has since rewritten, and the overview already ranks by the
 * recomputed value. Serving the stored card here would show a detail page whose
 * score disagrees with the row the reader clicked to get to it.
 *
 * It is computed by `currentScoreCard` from the stored snapshots and the
 * recorded rates — the inputs the series was written from — not from live
 * fetches, which is what once put GOOGL at STRONG BUY 8.3 here and BUY 7.7 in
 * the list. Viewing an older analysis carries *its* narrative, so only the
 * newest one is guaranteed to match the row.
 *
 * Returns the fields to overlay, or nothing when the inputs are unavailable.
 */
async function refreshedCard(
  symbol: string, stored: CachedAnalysisEntry,
): Promise<{ scoreCard?: ScoreCard; llmAnalysis?: LLMAnalysis }> {
  try {
    // As of the list's newest point, not the wall clock: the row shows the card
    // the last refresh wrote, and evaluating the same inputs at the same instant
    // is what makes the two one number rather than two readings a day apart.
    // An analysis newer than that point moves the instant up to itself.
    const instants = await scoreInstants(symbol);
    const lastPoint = instants.length ? instants[instants.length - 1].getTime() : Date.now();
    const readAt = stored.scoreCard?.narrative?.at ? Date.parse(stored.scoreCard.narrative.at) : 0;
    const scoreCard = await currentScoreCard(symbol, stored.scoreCard ?? null, Math.max(lastPoint, readAt || 0));
    if (!scoreCard) return {};
    return {
      scoreCard,
      llmAnalysis: {
        ...stored.llmAnalysis,
        score:          scoreCard.final.score,
        recommendation: scoreCard.final.verdict,
      },
    };
  } catch (e) {
    logger.warn(`${symbol}: could not refresh the score card — serving the stored one (${(e as Error).message})`);
    return {};
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

  // ── POST /api/stocks/:symbol/perplexity-refresh ────────────────────────────
  // Asks Perplexity again, past the cache window. Every analysis serves the
  // stored synthesis until the window runs out, so this is the one deliberate
  // way to pay for a new one sooner. Body: `{ model?: PerplexityModelId }`.
  app.post('/api/stocks/:symbol/perplexity-refresh', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      if (!cfg.pplxApiKey) {
        res.status(400).json({ error: 'Perplexity not configured — set PPLX_API_KEY in .env.' });
        return;
      }
      const requested = (req.body as { model?: unknown } | undefined)?.model;
      const model = isPerplexityModel(requested) ? requested : DEFAULT_PERPLEXITY_MODEL;

      const { perplexityRefresh } = await import('./hatchet/tasks/single.js');
      const { perplexity } = await viaHatchet(
        () => perplexityRefresh.run({ symbol, model }, interactive({ symbol })),
        async () => ({ perplexity: await refreshPerplexity(symbol, model, cfg.pplxApiKey!) as never }),
      );

      res.json({ ok: true, symbol, perplexity });
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
      const [config, financials, counts, members] = await Promise.all([
        readAppConfig(),
        latestSnapshotForAll<StockFinancials>('financials'),
        symbolCounts(),
        storedMembers(),
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
        referenceSymbols: counts.reference,
        universeSize:     members.length,
        universeFresh:    await refreshedWithin(members, 7),
        calibration: {
          generatedAt:       CALIBRATION_META.generatedAt,
          symbols:           CALIBRATION_META.symbols,
          observations:      CALIBRATION_META.observations,
          premiumAdjustment: CALIBRATION_META.premiumAdjustment,
          due:               calibrationDue(counts.watchlist + counts.reference),
        },
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
      await applyBacktestSchedule().catch((e) => logger.error(`Could not install backtest schedule: ${(e as Error).message}`));
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
      const [config, financials, verdicts, scoreSeries, cards, composites] = await Promise.all([
        readAppConfig(),
        latestSnapshotForAll<StockFinancials>('financials'),
        latestVerdictsForAll(),
        seriesForAll(KEY_SCORE),
        latestPointsForAll([...KEY_CARD]),
        latestValueForAll(KEY_COMPOSITE),
      ]);
      const marketRates = await getMarketRates(cfg.fredApiKey).catch(() => null);

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

        // The stored card belongs to the newest *analysis*; the series is
        // rewritten on every refresh. Read from the series, because that is
        // what has seen today's price — the document is the fallback for a
        // symbol analysed before the score card existed.
        const card = cards.get(symbol);
        const stored = newest?.scoreCard ?? null;

        // A null leaf is not written as a row — `projectRows` skips it — so the
        // newest point of a metric that has since stopped having a value is the
        // last time it *had* one. For `score.narrative.score`, which is null
        // whenever the summariser abstained or no prose existed, that would
        // leave a stale number sitting in the list. Every leaf of one card is
        // written in the same call at the same instant, so a point that does not
        // carry the card's own timestamp belongs to an older card and is absent
        // from this one. `score.factor.score` is the anchor: it is never null.
        const stamp = card?.get('score.factor.score')?.at;
        const num = (key: string) => {
          const point = card?.get(key);
          return point && point.at === stamp ? point.value ?? null : null;
        };
        const score = scoreHistory.length > 0
          ? scoreHistory[scoreHistory.length - 1].score
          : stored?.final.score ?? newest?.llmAnalysis.score ?? null;
        const recommendation = (card?.get('score.final.verdict')?.at === stamp
          ? card?.get('score.final.verdict')?.text
          : null)
          ?? stored?.final.verdict
          ?? newest?.llmAnalysis.recommendation
          ?? null;

        rows.push({
          symbol,
          companyName: f.companyName ?? symbol,
          sector:      f.sector ?? null,
          logoDomain:  logoDomainFromWebsite(f.website ?? null),
          price,
          marketCap:   typeof f.marketCap === 'number' ? f.marketCap : null,
          currency:    f.tradingCurrency ?? null,
          score:           score ?? null,
          factorScore:     num('score.factor.score')      ?? stored?.factor.score      ?? null,
          narrativeScore:  num('score.narrative.score')   ?? stored?.narrative?.score  ?? null,
          scoreConfidence: num('score.factor.confidence') ?? stored?.factor.confidence ?? null,
          scoreAgreement:  num('score.factor.agreement')  ?? stored?.factor.agreement  ?? null,
          recommendation:  recommendation ?? null,
          // Derived from the two values on screen rather than from the presence
          // of a cap: a label that sits in its own band was not held back,
          // whatever caps the payload earned.
          verdictCapped:   score !== null && recommendation !== null
            && verdictForScore(score) !== recommendation,
          capReasons:      stored?.factor.caps.map((c) => c.reason) ?? [],
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
          consensus:     computeConsensus(f, entries),
        });
      }

      // Score descending; stocks without a verdict sort to the bottom, then A→Z.
      rows.sort((a, b) => {
        if (a.score === null && b.score === null) return a.symbol.localeCompare(b.symbol);
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        if (b.score !== a.score) return b.score - a.score;
        return a.symbol.localeCompare(b.symbol);
      });
      res.json({ rows });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/evaluation?horizons=5,20,60&fresh=1 ─────────────────────────
  // Rank IC of every stored score signal against the returns that followed —
  // see src/analysis/evaluate.ts. Cached for hours: it fetches a year of
  // prices per symbol and its inputs move once a day.
  app.get('/api/evaluation', async (req, res, next) => {
    try {
      const horizons = typeof req.query.horizons === 'string'
        ? req.query.horizons.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 250)
        : [];
      const { at, value } = cachedEvaluation(horizons.length ? horizons : [5, 20, 60], req.query.fresh === '1');
      const report = await value;
      const body: EvaluationResponse = {
        computedAt: new Date(at).toISOString(),
        signals:    EVALUATED_SIGNALS.map(({ key, title, pillar, factor }) => ({
          key, title, pillar: pillar ?? false, factor: factor ?? false,
        })),
        evaluation:    report.watchlist,
        universe:      report.universe,
        weights:       report.weights.map((w) => ({ ...w, title: PILLAR_LABELS[w.key as PillarKey] ?? w.key })),
        weightHorizon: report.weightHorizon,
      };
      res.json(body);
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/backtest ──────────────────────────────────────────────────────
  // The stored result of `pnpm run backtest`: the factor score rebuilt at every
  // month-end since 2013 from the SEC's filings and judged on what followed.
  app.get('/api/backtest', async (_req, res, next) => {
    try {
      const body: BacktestResponse = {
        backtest: await storedBacktest(),
        signals:  EVALUATED_SIGNALS.filter((s) => s.factor).map(({ key, title, pillar }) => ({ key, title, pillar: pillar ?? false })),
        inForce:  { weights: WEIGHTS, fit: FITTED_WEIGHTS_META },
      };
      res.json(body);
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/feed?days=7 ───────────────────────────────────────────────────
  // What happened across the watchlist: every stock's timeline over the last
  // days on one axis, and the reports due in the next two weeks.
  app.get('/api/feed', async (req, res, next) => {
    try {
      const days = Number(req.query.days ?? 7);
      res.json(await watchlistFeed(Number.isFinite(days) ? Math.min(90, Math.max(1, Math.round(days))) : 7, req.query.fresh === '1'));
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/backtest/overview · POST /api/backtest/run ─────────────────────
  // The run in progress, the monthly schedule and every run kept; and a run
  // started now, as a child process (`backtest-service.ts`).
  app.get('/api/backtest/overview', async (_req, res, next) => {
    try {
      res.json(await backtestOverview());
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/backtest/run', async (_req, res, next) => {
    try {
      const r = await startBacktest('manual');
      res.status(r.started ? 202 : 409).json(r);
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/verdict-record?fresh=1 ────────────────────────────────────────
  // Every published verdict as a dated call, and how it did against the index
  // (`analysis/verdict-record.ts`). Cached for hours, like the evaluation.
  app.get('/api/verdict-record', async (req, res, next) => {
    try {
      res.json(await verdictRecordSummary(req.query.fresh === '1'));
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/verdict-changes?limit=30[&symbol=AAPL] ────────────────────────
  // The moments a watchlist stock's verdict moved to another band, newest first;
  // with `symbol`, only that stock's — the analysis shows its own.
  app.get('/api/verdict-changes', async (req, res, next) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
      const symbol = typeof req.query.symbol === 'string' && req.query.symbol ? req.query.symbol : undefined;
      res.json({ changes: await recentVerdictChanges(limit, symbol) });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/alerts/test ──────────────────────────────────────────────────
  // One message to the configured webhook, so the admin page can show it works
  // before the first real change needs it.
  app.post('/api/alerts/test', async (_req, res, next) => {
    try {
      const { webhookUrl, format } = (await readAppConfig()).alerts;
      if (!webhookUrl) {
        res.status(400).json({ ok: false, error: 'Keine Webhook-URL gespeichert' });
        return;
      }
      // A real announcement, marked as a test: what arrives is what a change will look like.
      const sample = verdictAlert('AAPL', { from: 'HOLD', to: 'BUY', score: 6.7 });
      const sent = await sendAlert(webhookUrl, format, {
        ...sample,
        title:  `Test · ${sample.title}`,
        text:   `stock-cli: Test — so sieht eine Urteilsänderung aus: ${sample.text}`,
        fields: { ...sample.fields, test: true },
      });
      res.json({ ok: sent.ok, error: sent.reason ?? undefined });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/alerts/digest/test ───────────────────────────────────────────
  // The morning's message as it would arrive now, marked as a test: the last
  // day across the watchlist. Remembers nothing, so the night's is unchanged.
  app.post('/api/alerts/digest/test', async (_req, res, next) => {
    try {
      const sent = await sendDigest({ test: true });
      res.json({ ok: sent.ok, events: sent.events, error: sent.reason ?? undefined });
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

  // ── GET /api/stocks/:symbol/valuation-history ──────────────────────────────
  // The last five years, month-end by month-end: price, the fair value the
  // models would have computed then, earnings and four multiples. Rebuilt on
  // first request and cached for a day, so the first open takes a few seconds.
  app.get('/api/stocks/:symbol/valuation-history', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const [history, sector, fair] = await Promise.all([
        getValuationHistory(symbol), sectorMultiples(symbol), fairRatios(symbol),
      ]);
      res.json({ symbol, history, sector, fair });
    } catch (e) {
      next(e);
    }
  });

  // ── The archive, read back ──────────────────────────────────────────────────
  // Views over what the refresh archives (`history-service.ts`) and the scores
  // it stored: how good the analysts' targets have been, how good our own
  // verdicts, what happened when, who holds the stock, and where the revenue
  // goes. All reads, no fetches.
  const archiveView = (path: string, read: (symbol: string, req: Request) => Promise<unknown>) =>
    app.get(`/api/stocks/:symbol/${path}`, async (req, res, next) => {
      try {
        const symbol = req.params.symbol.toUpperCase();
        res.json({ symbol, data: await read(symbol, req) });
      } catch (e) {
        next(e);
      }
    });
  archiveView('analysts', (s) => analystTrackRecord(s));
  archiveView('coverage', (s) => analystCoverage(s));
  archiveView('verdicts', (s) => verdictTrackRecord(s));
  archiveView('timeline', (s, req) => {
    const days = Number(req.query.days ?? 365);
    return stockTimeline(s, Number.isFinite(days) ? Math.min(3650, Math.max(30, days)) : 365);
  });
  archiveView('holders', (s) => stockHolders(s));
  archiveView('income-flow', (s) => incomeFlows(s));

  // ── GET /api/stocks/:symbol/peers ──────────────────────────────────────────
  // Who to compare a stock with, for the dialog in its header: the Finnhub
  // group its peer medians were computed from, and whoever else Yahoo files
  // under the same industry among the list and the reference universe. All of
  // it is already stored — only a Finnhub peer the database has never seen
  // costs anything, one batched Yahoo quote for the names.
  app.get('/api/stocks/:symbol/peers', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const [own, medians] = await Promise.all([
        peersBySymbol([symbol]),
        lastGoodSectorMedians(symbol),
      ]);
      const self = own.get(symbol);
      if (!self) {
        res.status(404).json({ error: `No financials stored for ${symbol} yet` });
        return;
      }

      // Finnhub spells a share class with a dot, Yahoo and the database with a dash.
      const peerSymbols = [...new Set((medians?.peers ?? []).map(yahooTicker))].filter((p) => p !== symbol);
      const [stored, industryPeers] = await Promise.all([
        peersBySymbol(peerSymbols),
        self.industry
          ? peersByIndustry(self.industry, [symbol, ...peerSymbols], INDUSTRY_PEER_LIMIT)
          : Promise.resolve([]),
      ]);
      const quoted = await quoteBriefs(peerSymbols.filter((p) => !stored.has(p)));

      const peers = peerSymbols.map((p) => {
        const known = stored.get(p);
        return known ? peerRow(known) : unknownPeerRow(p, quoted.get(p));
      });
      const body: PeersResponse = {
        symbol,
        industry: self.industry,
        self:     peerRow(self),
        peers,
        industryPeers: onePerCompany(industryPeers.map(peerRow), [self.companyName, ...peers.map((p) => p.companyName)]),
      };
      res.json(body);
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/stocks/:symbol/logo ───────────────────────────────────────────
  // Redirects to the ticker's TradingView logo, or 404s so the browser's logo
  // cascade moves on to the next source.
  app.get('/api/stocks/:symbol/logo', async (req, res, next) => {
    try {
      const url = await tradingViewLogoUrl(req.params.symbol);
      res.set('Cache-Control', 'public, max-age=86400');
      if (url) res.redirect(302, url);
      else res.status(404).end();
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

      const [msSnap, news, perplexity, deepResearch, distill, summary] = await Promise.all([
        readMarketSignalsMeta(symbol),
        readNewsLax(symbol),
        readPerplexityLax(symbol),
        readDeepResearchLax(symbol),
        readDistillLax(symbol),
        buildStockSummary(symbol),
      ]);

      // The models on this page are the ones the score was computed from: the
      // stored peer medians and the recorded rates, not a fresh fetch that can
      // come back different (an empty peer group, a premium read an hour later)
      // and leave the fair values here disagreeing with the score beside them.
      const inputs = await storedInputs(symbol);
      const sectorMedians = inputs?.sectorMedians ?? null;
      const marketSignals = msSnap?.data ?? null;
      const metrics = computeAllMetrics(financials, inputs?.rates ?? null, sectorMedians);

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
        deepResearch,
        distill,
        metrics,
        sectorMedians,
        marketRates: inputs?.rates ?? null,
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
      // Same overlay as the by-flags route: stored prose, arithmetic as of now.
      res.json({ ...doc.data, ...(await refreshedCard(symbol, doc.data)) });
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
        pplx:   isPerplexityModel(req.query.pplx) ? req.query.pplx : null,
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
      res.json({ ...stored, ...(await refreshedCard(symbol, stored)) });
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
        pplx?: PerplexityModelId | null;
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
    const pplx: PerplexityModelId | null = isPerplexityModel(pplxQ) ? pplxQ : null;
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
      + '(in production, the stockcli-worker-* containers).');
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
      // In the background: the server answers from the existing series while
      // the history catches up with a changed scoring model.
      rescoreIfScoringChanged().catch((e) => {
        logger.warn(`Re-score on start failed — the series keeps its previous numbers (${(e as Error).message})`);
      });
      const app = createApp();
      const server = app.listen(PORT, () => {
        logger.success(`Stock-CLI server listening on http://localhost:${PORT}`);
        logger.info(`Endpoints:`);
        logger.info(`  GET  /api/health                       — liveness probe`);
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
        reconcileBacktestStatus()
          .then(() => applyBacktestSchedule())
          .catch((e) => logger.error(`Could not install backtest schedule: ${(e as Error).message}`));
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
