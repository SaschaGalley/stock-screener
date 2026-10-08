/**
 * The depot check, run: the best stocks off the depot analysed as the stock
 * page's „Alles“ would analyse them, their charts and the weak holdings' charts
 * read, the lot sorted (`analysis/depot-check.ts`), and a depot manager's view
 * asked of the model on top.
 *
 * One run at a time, in this process, and minutes long: twenty-five analyses
 * and as many chart readings. Its progress and its result are kept in
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
  classifyDepotCheck, managerInput, MANAGER_ACTIONS, MANAGER_SYSTEM, managerUser, selectCandidates,
  type CheckedStock, type DepotCheckResult, type DepotCheckStatus, type ManagerView,
  type ScoredStock,
} from './analysis/depot-check.js';
import type { ChartRead } from './analysis/chart.js';
import { runChartRead } from './chart-service.js';
import { runAnalysis } from './cli.js';
import { readAppState, writeAppState } from './db/admin.js';
import { latestDocument, latestPointsForAll, listSymbols, symbolFacts } from './db/store.js';
import { readDepot } from './depot-service.js';
import { invalidateDiscover } from './discover-service.js';
import { isHatchetConfigured } from './hatchet/client.js';
import { interactive, NoWorkerError, viaHatchet } from './hatchet/via.js';
import { createProviderForModel } from './providers/factory.js';
import { refreshStockData } from './refresh.js';
import { tradesSource } from './trades-service.js';
import { logger } from './utils/logger.js';
import { settledPool } from './utils/pool.js';

const STATUS_KEY = () => `depot.check.${tradesSource()}.status`;
const RESULT_KEY = () => `depot.check.${tradesSource()}.result`;

/** Stocks worked on at once: each holds an analysis in a worker or an LLM call here. */
const CONCURRENCY = 3;

/** A chart reading younger than this is read again for free: the chart has hardly moved. */
const CHART_REUSE_MS = 24 * 60 * 60 * 1000;

const SCORE = 'score.final.score';
const VERDICT = 'score.final.verdict';

let running = false;

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await readAppState(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

/** `GET /api/depot/check` */
export async function readDepotCheck(): Promise<DepotCheckResponse> {
  const [status, result, config] = await Promise.all([
    readJson<DepotCheckStatus>(STATUS_KEY()), readJson<DepotCheckResult>(RESULT_KEY()), readAppConfig(),
  ]);
  return { status, result, settings: config.depotCheck };
}

/** At boot: a run that was going when the process died is not going any more. */
export async function reconcileDepotCheck(): Promise<void> {
  const s = await readJson<DepotCheckStatus>(STATUS_KEY());
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
  const weak = view.positions.filter((p) => p.symbol && p.score !== null && p.score < settings.reduceBelow);
  const total = candidates.length + weak.length;
  await save({ total, phase: candidates.length ? `Analyse 0/${candidates.length}` : 'Charts der Depotwerte' });
  logger.info(`Depot check: ${candidates.length} candidates at ${settings.minScore}+, ${weak.length} weak holdings`);

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
    const chart = await chartOf(c.symbol, flags.model).catch((e) => { error ??= `Chart: ${(e as Error).message}`; return null; });
    await step(`Analyse ${done + 1}/${candidates.length}: ${c.symbol}`);
    return { ...c, scoreBefore: c.score, chart, weight: null, error };
  });
  if (candidates.length) invalidateDiscover();

  // The weak holdings: their charts, the analysis they have is the night's.
  const holdingCharts = await settledPool(weak, CONCURRENCY, async (p) => {
    const chart = await chartOf(p.symbol!, flags.model).catch(() => null);
    await step(`Chart ${p.symbol}`);
    return [p.symbol!, chart] as const;
  });
  const charts = new Map<string, CheckedStock['chart']>(
    holdingCharts.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
  );

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
    : { ...candidates[i], scoreBefore: candidates[i].score, chart: null, weight: null, error: String(r.reason) }));
  const holdings: CheckedStock[] = weak.map((p) => ({
    symbol: p.symbol!, name: p.name, sector: p.sector, score: p.score, verdict: p.verdict,
    scoreBefore: null, chart: charts.get(p.symbol!) ?? null, weight: p.weight, error: charts.get(p.symbol!) ? null : 'Chart nicht gelesen',
  }));
  const lists = classifyDepotCheck(checkedCandidates, holdings, settings);

  // The manager: the one model call that sees the depot, through `managerInput`.
  await save({ phase: 'Depotmanager' });
  let manager: ManagerView | null = null;
  let managerError: string | null = null;
  try {
    const input = managerInput({
      positions: view.positions, sectors: view.sectors, lists,
      charts: new Map([...charts, ...checkedCandidates.map((c) => [c.symbol, c.chart] as const)]),
      limits: { maxPosition: view.limits.maxPosition, maxSector: view.limits.maxSector },
    });
    manager = await createProviderForModel(flags.model).complete({
      label: 'depot-manager', system: MANAGER_SYSTEM, user: managerUser(input), schema: ManagerSchema, maxTokens: 6000,
    });
  } catch (e) {
    managerError = (e as Error).message;
    logger.warn(`Depot manager: ${managerError}`);
  }

  const result: DepotCheckResult = {
    generatedAt: new Date().toISOString(), settings, model: flags.model,
    candidates: checkedCandidates, holdings, lists, manager, managerError,
  };
  await writeAppState(RESULT_KEY(), JSON.stringify(result));
}

const ManagerSchema = z.object({
  summary: z.string().describe('Drei bis fünf Sätze: was ein Depotmanager mit diesem Depot jetzt tun würde, und warum.'),
  moves: z.array(z.object({
    action: z.enum(MANAGER_ACTIONS),
    symbol: z.string().describe('Ticker der Aktie, wie in den Daten'),
    reason: z.string().describe('Ein Satz Begründung aus den Daten'),
  })).describe('Die Schritte, je Aktie einer, die wichtigsten zuerst; höchstens zehn.'),
  risks: z.array(z.string()).describe('Was ein Depotmanager im Blick behält: Klumpen, Sektoren, was gegen die Schritte spricht.'),
});

/** The model's reading of a stock's chart: a fresh one is reused, else it is read now. */
async function chartOf(symbol: string, model: string): Promise<CheckedStock['chart']> {
  const doc = await latestDocument<ChartRead>(symbol, 'chart');
  const read = doc?.data && Date.now() - Date.parse(doc.producedAt) < CHART_REUSE_MS
    ? doc.data
    : (await runChartRead(symbol, model)).read;
  return { trend: read.trend.direction, summary: read.summary, asOf: read.asOf };
}
