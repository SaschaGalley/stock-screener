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
  selectCandidates, type CheckedStock, type DepotCheckResult, type DepotCheckStatus, type ReasonForManager,
  type ScoredStock, type TradeForManager,
} from './analysis/depot-check.js';
import type { DepotPosition } from './analysis/depot.js';
import type { MarketBrief } from './analysis/market-brief.js';
import type { SectorTrend } from './analysis/sector-rotation.js';
import { protectionOf } from './analysis/stops.js';
import { readChart, runChartRead } from './chart-service.js';
import { runAnalysis } from './cli.js';
import { writeAppState } from './db/admin.js';
import { CHECK_RESULT_KEY, CHECK_STATUS_KEY, readDepotNotes, readStateJson } from './depot-check-state.js';
import {
  changesSince, checkSteps, groupRecord, stepHit, type DepotCheckHistory, type StepOutcome,
} from './analysis/depot-check-record.js';
import { listDepotChecks, saveDepotCheck } from './db/depot-check-store.js';
import { listJournal } from './db/journal-store.js';
import { allTrades } from './db/trades-store.js';
import { stopEvidence } from './backtest/result.js';
import { decisionOutcomes } from './stock-history-service.js';
import { tradesSource } from './trades-service.js';
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
  // Polled every few seconds while a check runs; the history is only read when one is not.
  const history = status?.state === 'running' ? null : await checkHistory().catch((e) => {
    logger.warn(`Depot check history: ${(e as Error).message}`);
    return null;
  });
  return {
    status, result, settings: config.depotCheck, history, notes: await readDepotNotes(),
    stopEvidence: await stopEvidence().catch(() => null),
  };
}

/** The measured history changes with a new check or a new trading day; read at most every ten minutes. */
const HISTORY_TTL_MS = 10 * 60_000;
let historyMemo: { at: number; key: string; value: DepotCheckHistory | null } | null = null;

/**
 * Every check kept and what came of its steps: each measured from the check's
 * day against the S&P 500, in dollars, as the review measures a purchase.
 */
async function checkHistory(): Promise<DepotCheckHistory | null> {
  const checks = await listDepotChecks(tradesSource());
  if (checks.length === 0) return null;
  const key = `${tradesSource()}|${checks[0].id}|${checks.length}`;
  if (historyMemo && historyMemo.key === key && Date.now() - historyMemo.at < HISTORY_TTL_MS) return historyMemo.value;

  const steps = checkSteps(checks);
  const from = new Date(Date.parse(steps.reduce((a, s) => (s.day < a ? s.day : a), steps[0]?.day ?? new Date().toISOString())) - 10 * 86_400_000)
    .toISOString().slice(0, 10);
  const { outcomes } = await decisionOutcomes(steps.map((s) => ({ key: s.key, symbol: s.symbol, day: s.day, side: 'buy' as const })), from);
  const measured: StepOutcome[] = steps.map((s) => {
    const held = outcomes.get(s.key)?.held ?? null;
    return { ...s, stock: held?.stock ?? null, excess: held?.excess ?? null, hit: stepHit(s.group, held?.excess ?? null) };
  });
  const value: DepotCheckHistory = {
    checks: checks.map((c) => ({ id: c.id, generatedAt: c.result.generatedAt, moves: c.result.manager?.moves.length ?? 0, model: c.result.model })),
    record: groupRecord(measured, new Date().toISOString().slice(0, 10)),
    changes: changesSince(checks[1]?.result ?? null, checks[0].result),
    outcomes: measured,
  };
  historyMemo = { at: Date.now(), key, value };
  return value;
}

/**
 * At boot: a run that was going when the process died is not going any more,
 * and a result from before the checks were kept is kept now.
 */
export async function reconcileDepotCheck(): Promise<void> {
  const result = await readStateJson<DepotCheckResult>(RESULT_KEY());
  if (result) await saveDepotCheck(tradesSource(), result).catch((e) => logger.warn(`Depot check not kept: ${(e as Error).message}`));
  const s = await readStateJson<DepotCheckStatus>(STATUS_KEY());
  if (s?.state !== 'running' || running) return;
  await writeAppState(STATUS_KEY(), JSON.stringify({ ...s, state: 'interrupted', finishedAt: new Date().toISOString() }));
}

/** `POST /api/depot/check`: start a run unless one is going. */
export function startDepotCheck(): Promise<{ started: boolean; reason?: string }> {
  return startRun('Kandidaten wählen', runCheck);
}

/**
 * `POST /api/depot/check/manager`: ask the manager again, on the last check's
 * analyses, charts and market, with today's depot and the owner's notes — one
 * model call where a check is minutes of them.
 */
export async function startManagerAgain(): Promise<{ started: boolean; reason?: string }> {
  if (!(await readStateJson<DepotCheckResult>(RESULT_KEY()))) return { started: false, reason: 'Noch kein Depot-Check, den der Manager neu lesen könnte.' };
  return startRun('Depotmanager', runManagerAgain);
}

type Save = (patch: Partial<DepotCheckStatus>) => Promise<void>;

async function startRun(phase: string, run: (save: Save) => Promise<void>): Promise<{ started: boolean; reason?: string }> {
  if (running) return { started: false, reason: 'Ein Depot-Check läuft schon.' };
  running = true;
  const status: DepotCheckStatus = {
    state: 'running', startedAt: new Date().toISOString(), finishedAt: null, phase, done: 0, total: 0, error: null,
  };
  const save = (patch: Partial<DepotCheckStatus>) => {
    Object.assign(status, patch);
    return writeAppState(STATUS_KEY(), JSON.stringify(status)).catch((e) => logger.warn(`Depot check status: ${(e as Error).message}`));
  };
  await save({});
  void run(save)
    .then(() => save({ state: 'done', phase: null, finishedAt: new Date().toISOString() }))
    .catch(async (e) => {
      logger.error(`Depot check failed: ${(e as Error).message}`);
      await save({ state: 'failed', phase: null, error: (e as Error).message, finishedAt: new Date().toISOString() });
    })
    .finally(() => { running = false; });
  return { started: true };
}

async function runCheck(save: Save): Promise<void> {
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
  const asked = await askManager(view, { holdings, lists, market: brief, sectorTrends }, flags.model);

  const result: DepotCheckResult = {
    generatedAt: new Date().toISOString(), settings, model: flags.model,
    candidates: checkedCandidates, holdings, lists,
    market: brief, marketError, sectorTrends,
    ...asked,
  };
  await writeAppState(RESULT_KEY(), JSON.stringify(result));
  await saveDepotCheck(tradesSource(), result);
}

/**
 * Each stock's open position as the manager reads it: its trades, and the
 * journal's reasons for them — the purchase and sale entries linked to one of
 * them or naming the stock since the position was opened. The journal's other
 * notes stay here.
 */
async function tradeHistory(positions: readonly DepotPosition[]) {
  const [trades, journal] = await Promise.all([allTrades(tradesSource()), listJournal()]);
  const byId = new Map(trades.map((t) => [t.id, t]));
  const out = { trades: new Map<string, TradeForManager[]>(), reasons: new Map<string, ReasonForManager[]>() };
  for (const p of positions) {
    if (!p.symbol || !isSingleStock(p)) continue;
    const symbol = p.symbol;
    const ids = new Set(p.tradeIds);
    out.trades.set(symbol, p.tradeIds.flatMap((id) => byId.get(id) ?? []));
    out.reasons.set(symbol, journal.flatMap((j) => ((j.kind === 'buy' || j.kind === 'sell')
      && (j.tradeIds.some((id) => ids.has(id)) || (j.symbols.includes(symbol) && j.day >= p.openedAt))
      ? [{ day: j.day, kind: j.kind, body: j.body }] : [])));
  }
  return out;
}

/**
 * The manager asked: the one model call that sees the depot, through
 * `managerInput`, with the owner's notes as he wrote them for it.
 */
async function askManager(
  view: NonNullable<Awaited<ReturnType<typeof readDepot>>['view']>,
  check: Pick<DepotCheckResult, 'holdings' | 'lists' | 'sectorTrends'> & { market: MarketBrief | null },
  model: string,
): Promise<Pick<DepotCheckResult, 'manager' | 'managerError' | 'managerAt' | 'notes'>> {
  const notes = Object.fromEntries(Object.entries(await readDepotNotes()).map(([k, n]) => [k, n.text]));
  try {
    const history = await tradeHistory(view.positions);
    const input = managerInput({
      positions: view.positions, sectors: view.sectors, lists: check.lists,
      holdings: new Map(check.holdings.map((h) => [h.symbol, h])),
      limits: { maxPosition: view.limits.maxPosition, maxSector: view.limits.maxSector },
      market: check.market, sectorTrends: check.sectorTrends ?? [], lookThrough: view.lookThrough,
      cashShare: view.cashEur !== null && view.totalEur > 0 ? view.cashEur / view.totalEur : null,
      notes: new Map(Object.entries(notes)),
      trades: history.trades, reasons: history.reasons,
      evidence: await stopEvidence().catch(() => null),
    });
    const manager = await createProviderForModel(model).complete({
      label: 'depot-manager', system: MANAGER_SYSTEM, user: managerUser(input), schema: ManagerSchema, maxTokens: 10_000,
    });
    return { manager, managerError: null, managerAt: new Date().toISOString(), notes };
  } catch (e) {
    const managerError = (e as Error).message;
    logger.warn(`Depot manager: ${managerError}`);
    return { manager: null, managerError, managerAt: new Date().toISOString(), notes };
  }
}

/** The manager asked again on the last check, with today's depot and notes; the charts' stops brought up to date. */
async function runManagerAgain(save: Save): Promise<void> {
  const last = await readStateJson<DepotCheckResult>(RESULT_KEY());
  if (!last) throw new Error('Kein Depot-Check vorhanden.');
  const depot = await readDepot();
  if (!depot.view) throw new Error(depot.syncError ?? 'Kein Depot: umsatz hat keine Trades geliefert.');
  await save({ phase: 'Depotmanager' });
  // The levels from tonight's bars and the stored reading: no chart is read anew.
  const holdings = await Promise.all(last.holdings.map(async (h) => {
    const c = await readChart(h.symbol).catch(() => null);
    if (!c?.analysis) return h;
    const levels = c.read?.read.levels.map((l) => ({ price: l.price, kind: l.kind, strength: l.strength }));
    return { ...h, protection: protectionOf(c.bars, c.analysis, c.currency), chart: h.chart ? { ...h.chart, levels: h.chart.levels ?? levels } : h.chart };
  }));
  // The model set today, not the last run's: the setting may have changed since.
  const model = analysisFlagsFor(await readAppConfig()).model;
  const asked = await askManager(depot.view, { ...last, holdings, market: last.market ?? null }, model);
  const result: DepotCheckResult = { ...last, holdings, ...asked };
  await writeAppState(RESULT_KEY(), JSON.stringify(result));
  await saveDepotCheck(tradesSource(), result);
}

const ManagerSchema = z.object({
  summary: z.string().describe('Drei bis fünf Sätze: was ein Depotmanager mit diesem Depot jetzt tun würde, und warum.'),
  moves: z.array(z.object({
    action:  z.enum(MANAGER_ACTIONS),
    symbol:  z.string().describe('Ticker der Aktie, wie in den Daten'),
    protect: z.enum(PROTECTIONS).nullable().catch(null).describe('Schutz einer Aktie im Depot; null bei einem Kauf'),
    targetPct: z.number().min(0).max(100).nullable().catch(null).describe('Gewicht nach dem Schritt in Prozent des heutigen Depotwerts; null bei halten und beobachten'),
    stopPrice: z.number().positive().nullable().catch(null).describe('Eigene Stop-Marke in der Handelswährung, wenn die Notiz des Anlegers eine tragfähige nennt; sonst null'),
    noteReply: z.string().nullable().catch(null).describe('Antwort auf die Notiz des Anlegers zu dieser Aktie; ohne Notiz null'),
    reason:  z.string().describe('Ein bis zwei Sätze: warum, aus den Daten — ohne Zielgewicht, Beträge, Stop-Marke oder Trailing-Abstand, die zeigt die Seite'),
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
      return {
        chart: {
          trend: read.trend.direction, phase: read.trend.phase, summary: read.summary, asOf: read.asOf,
          levels: read.levels.map((l) => ({ price: l.price, kind: l.kind, strength: l.strength })),
        },
        protection, error: null,
      };
    } catch (e) {
      return { chart: null, protection, error: `Chart: ${(e as Error).message}` };
    }
  } catch (e) {
    return { chart: null, protection: null, error: `Chart: ${(e as Error).message}` };
  }
}
