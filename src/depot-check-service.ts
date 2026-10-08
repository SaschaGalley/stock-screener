/**
 * The depot check, run: the best stocks off the depot analysed as the stock
 * page's „Alles“ would analyse them, their charts and the charts of every
 * single stock held read, the stops worked out from the bars, the market
 * brief and the sector funds beside them, the lot sorted
 * (`analysis/depot-check.ts`), and a depot manager's view asked of the model on
 * top.
 *
 * One run at a time, in this process, and minutes long: twenty-five analyses
 * and as many chart readings again. Its progress and its result are kept in
 * `app_state`, under the trades source, so a placeholder's check in
 * development never overwrites the real one. A run this process did not finish
 * — the server restarted under it — is marked interrupted at the next boot.
 *
 * Candidates come from the list and from the reference universe alike. A
 * universe stock that is analysed is promoted to the list by its refresh, the
 * way adding it by hand would, and the nightly run covers it from then on.
 *
 * Real holdings: develop against a placeholder (CLAUDE.md).
 */

import { z } from 'zod';

import type { DepotCheckResponse } from './api-types.js';
import { analysisFlagsFor, readAppConfig } from './app-config.js';
import {
  classifyDepotCheck, isSingleStock, managerInput, MANAGER_ACTIONS, MANAGER_SYSTEM, managerUser, PROTECTIONS,
  selectCandidates, type CheckedStock, type DepotCheckResult, type DepotCheckStatus, type ManagerView,
  type ScoredStock,
} from './analysis/depot-check.js';
import type { MarketBrief } from './analysis/market-brief.js';
import type { SectorTrend } from './analysis/sector-rotation.js';
import { protectionOf } from './analysis/stops.js';
import { readChart, runChartRead } from './chart-service.js';
import { runAnalysis } from './cli.js';
import { writeAppState } from './db/admin.js';
import { CHECK_RESULT_KEY, CHECK_STATUS_KEY, readStateJson } from './depot-check-state.js';
import { latestPointsForAll, listSymbols, symbolFacts } from './db/store.js';
import { readDepot } from './depot-service.js';
import { invalidateDiscover } from './discover-service.js';
import { isHatchetConfigured } from './hatchet/client.js';
import { interactive, NoWorkerError, viaHatchet } from './hatchet/via.js';
import { marketBrief, sectorTrendsNow } from './market-service.js';
import { createProviderForModel } from './providers/factory.js';
import { refreshStockData } from './refresh.js';
import { logger } from './utils/logger.js';
import { settledPool } from './utils/pool.js';

const STATUS_KEY = CHECK_STATUS_KEY;
const RESULT_KEY = CHECK_RESULT_KEY;

/** Stocks worked on at once: each holds an analysis in a worker or an LLM call here. */
const CONCURRENCY = 3;

/** A chart reading younger than this is read again for free: the chart has hardly moved. */
const CHART_REUSE_MS = 24 * 60 * 60 * 1000;

const SCORE = 'score.final.score';
const VERDICT = 'score.final.verdict';

let running = false;

/** `GET /api/depot/check` */
export async function readDepotCheck(): Promise<DepotCheckResponse> {
  const [status, result, config] = await Promise.all([
    readStateJson<DepotCheckStatus>(STATUS_KEY()), readStateJson<DepotCheckResult>(RESULT_KEY()), readAppConfig(),
  ]);
  return { status, result, settings: config.depotCheck };
}

/** At boot: a run that was going when the process died is not going any more. */
export async function reconcileDepotCheck(): Promise<void> {
  const s = await readStateJson<DepotCheckStatus>(STATUS_KEY());
  if (s?.state !== 'running' || running) return;
  await writeAppState(STATUS_KEY(), JSON.stringify({ ...s, state: 'interrupted', finishedAt: new Date().toISOString() }));
}

/** `POST /api/depot/check`: start a run unless one is going. */
export async function startDepotCheck(): Promise<{ started: boolean; reason?: string }> {
  if (running) return { started: false, reason: 'Ein Depot-Check läuft schon.' };
  running = true;
  const status: DepotCheckStatus = {
    state: 'running', startedAt: new Date().toISOString(), finishedAt: null, phase: 'Kandidaten wählen', done: 0, total: 0, error: null,
  };
  const save = (patch: Partial<DepotCheckStatus>) => {
    Object.assign(status, patch);
    return writeAppState(STATUS_KEY(), JSON.stringify(status)).catch((e) => logger.warn(`Depot check status: ${(e as Error).message}`));
  };
  await save({});
  void runCheck(save)
    .then(() => save({ state: 'done', phase: null, finishedAt: new Date().toISOString() }))
    .catch(async (e) => {
      logger.error(`Depot check failed: ${(e as Error).message}`);
      await save({ state: 'failed', phase: null, error: (e as Error).message, finishedAt: new Date().toISOString() });
    })
    .finally(() => { running = false; });
  return { started: true };
}

async function runCheck(save: (patch: Partial<DepotCheckStatus>) => Promise<void>): Promise<void> {
  const config = await readAppConfig();
  const settings = config.depotCheck;
  const flags = analysisFlagsFor(config);

  // Checked once, up front: without a worker every analysis would fail alike.
  if (isHatchetConfigured()) {
    const { hasActiveWorker } = await import('./hatchet/activity.js');
    if (!await hasActiveWorker()) throw new NoWorkerError();
  }

  const depot = await readDepot();
  const view = depot.view;
  if (!view) throw new Error(depot.syncError ?? 'Kein Depot: umsatz hat keine Trades geliefert.');
  const held = new Set(view.positions.flatMap((p) => (p.symbol ? [p.symbol] : [])));

  // The market, asked beside everything else: nothing of the depot goes into either.
  const market = settings.marketModel
    ? marketBrief(settings.marketModel).then((brief) => ({ brief, error: null }), (e: Error) => {
      logger.warn(`Market brief: ${e.message}`);
      return { brief: null as MarketBrief | null, error: e.message };
    })
    : Promise.resolve({ brief: null as MarketBrief | null, error: null });
  const trends = sectorTrendsNow().catch((e: Error): SectorTrend[] => { logger.warn(`Sector trends: ${e.message}`); return []; });

  // Every stored stock with a score, the list's and the universe's.
  const symbols = await listSymbols('all');
  const [points, facts] = await Promise.all([
    latestPointsForAll([SCORE, VERDICT], { withReference: true }), symbolFacts(symbols),
  ]);
  const scored = (symbol: string): ScoredStock => ({
    symbol,
    name:    facts.get(symbol)?.name ?? null,
    sector:  facts.get(symbol)?.sector ?? null,
    score:   points.get(symbol)?.get(SCORE)?.value ?? null,
    verdict: points.get(symbol)?.get(VERDICT)?.text ?? null,
  });
  const candidates = selectCandidates(symbols.map(scored), held, settings);
  const stocks = view.positions.filter((p) => p.symbol && isSingleStock(p));
  const total = candidates.length + stocks.length;
  await save({ total, phase: candidates.length ? `Analyse 0/${candidates.length}` : 'Charts der Depotwerte' });
  logger.info(`Depot check: ${candidates.length} candidates at ${settings.minScore}+, ${stocks.length} stocks held`);

  let done = 0;
  const step = async (phase: string) => { done++; await save({ done, phase }); };

  // Candidates: refreshed (which lists a universe stock), analysed, the chart read.
  const analysed = await settledPool(candidates, CONCURRENCY, async (c): Promise<CheckedStock> => {
    let error: string | null = null;
    try {
      await viaHatchet(
        async () => { const { refreshData } = await import('./hatchet/tasks/single.js'); await refreshData.run({ symbol: c.symbol, includeDistill: false }, interactive({ symbol: c.symbol })); },
        async () => { await refreshStockData(c.symbol, { includeDistill: false }); },
      );
      await viaHatchet(
        async () => { const { analyze } = await import('./hatchet/tasks/single.js'); await analyze.run({ input: c.symbol, model: flags.model, search: flags.search, pplx: flags.pplx }, interactive({ symbol: c.symbol })); },
        async () => { await runAnalysis({ symbol: c.symbol, model: flags.model, search: flags.search, pplx: flags.pplx, force: false, verbose: false }); },
      );
    } catch (e) {
      error = `Analyse: ${(e as Error).message}`;
    }
    const seen = await look(c.symbol, flags.model);
    await step(`Analyse ${done + 1}/${candidates.length}: ${c.symbol}`);
    return { ...c, scoreBefore: c.score, ...seen, error: error ?? seen.error, weight: null };
  });
  if (candidates.length) invalidateDiscover();

  // The stocks held: their charts and stops; the analysis they have is the night's.
  const checkedHoldings = await settledPool(stocks, CONCURRENCY, async (p): Promise<CheckedStock> => {
    const seen = await look(p.symbol!, flags.model);
    await step(`Chart ${p.symbol}`);
    return {
      symbol: p.symbol!, name: p.name, sector: p.sector, score: p.score, verdict: p.verdict,
      scoreBefore: null, weight: p.weight, gain: p.gain, ...seen,
    };
  });

  // The scores as the analyses left them.
  await save({ phase: 'Einordnen' });
  const after = await latestPointsForAll([SCORE, VERDICT], { withReference: true });
  const now = (c: CheckedStock): CheckedStock => ({
    ...c,
    score:   after.get(c.symbol)?.get(SCORE)?.value ?? c.score,
    verdict: after.get(c.symbol)?.get(VERDICT)?.text ?? c.verdict,
  });
  const checkedCandidates = analysed.map((r, i) => (r.status === 'fulfilled'
    ? now(r.value)
    : { ...candidates[i], scoreBefore: candidates[i].score, chart: null, protection: null, weight: null, error: String(r.reason) }));
  const holdings: CheckedStock[] = checkedHoldings.map((r, i) => (r.status === 'fulfilled' ? r.value : {
    symbol: stocks[i].symbol!, name: stocks[i].name, sector: stocks[i].sector, score: stocks[i].score, verdict: stocks[i].verdict,
    scoreBefore: null, chart: null, protection: null, weight: stocks[i].weight, gain: stocks[i].gain, error: String(r.reason),
  }));
  const lists = classifyDepotCheck(checkedCandidates, holdings, settings);

  // The manager: the one model call that sees the depot, through `managerInput`.
  await save({ phase: 'Marktlage und Depotmanager' });
  const [{ brief, error: marketError }, sectorTrends] = await Promise.all([market, trends]);
  let manager: ManagerView | null = null;
  let managerError: string | null = null;
  try {
    const input = managerInput({
      positions: view.positions, sectors: view.sectors, lists,
      holdings: new Map(holdings.map((h) => [h.symbol, h])),
      limits: { maxPosition: view.limits.maxPosition, maxSector: view.limits.maxSector },
      market: brief, sectorTrends, lookThrough: view.lookThrough,
    });
    manager = await createProviderForModel(flags.model).complete({
      label: 'depot-manager', system: MANAGER_SYSTEM, user: managerUser(input), schema: ManagerSchema, maxTokens: 10_000,
    });
  } catch (e) {
    managerError = (e as Error).message;
    logger.warn(`Depot manager: ${managerError}`);
  }

  const result: DepotCheckResult = {
    generatedAt: new Date().toISOString(), settings, model: flags.model,
    candidates: checkedCandidates, holdings, lists,
    market: brief, marketError, sectorTrends,
    manager, managerError,
  };
  await writeAppState(RESULT_KEY(), JSON.stringify(result));
}

const ManagerSchema = z.object({
  summary: z.string().describe('Drei bis fünf Sätze: was ein Depotmanager mit diesem Depot jetzt tun würde, und warum.'),
  moves: z.array(z.object({
    action:  z.enum(MANAGER_ACTIONS),
    symbol:  z.string().describe('Ticker der Aktie, wie in den Daten'),
    protect: z.enum(PROTECTIONS).nullable().catch(null).describe('Schutz einer Aktie im Depot; null bei einem Kauf'),
    reason:  z.string().describe('Ein bis zwei Sätze Begründung aus den Daten'),
  })).describe('Zuerst jede Aktie im Depot, die dringendsten zuerst; dann höchstens fünf Käufe.'),
  risks: z.array(z.string()).describe('Was ein Depotmanager im Blick behält: Klumpen, Sektoren, Markt, was gegen die Schritte spricht.'),
});

/**
 * A stock's chart, as the check sees it: the model's reading — a fresh one is
 * reused, else it is read now — and the stops worked out from the same bars.
 * A reading that fails leaves the stops; no bars leave neither.
 */
async function look(symbol: string, model: string): Promise<Pick<CheckedStock, 'chart' | 'protection' | 'error'>> {
  try {
    const c = await readChart(symbol);
    const protection = c.analysis ? protectionOf(c.bars, c.analysis, c.currency) : null;
    try {
      const read = c.read && Date.now() - Date.parse(c.read.producedAt) < CHART_REUSE_MS
        ? c.read.read
        : (await runChartRead(symbol, model)).read;
      return { chart: { trend: read.trend.direction, phase: read.trend.phase, summary: read.summary, asOf: read.asOf }, protection, error: null };
    } catch (e) {
      return { chart: null, protection, error: `Chart: ${(e as Error).message}` };
    }
  } catch (e) {
    return { chart: null, protection: null, error: `Chart: ${(e as Error).message}` };
  }
}
