/**
 * The depot view, assembled: the trades and euro prices from umsatz, the
 * watchlist's scores, the journal's reasons, the thesis checks and the
 * backtest's record of the verdicts; for each stock held its chart reading,
 * the night watch's signals, the score four weeks ago and what is scheduled;
 * the funds' holdings for the look-through, and the market's dates. See
 * `analysis/depot.ts` for what it computes and why it stops short of target
 * weights.
 *
 * Real holdings: develop against it in aggregate only (see CLAUDE.md).
 */

import { readAppConfig } from './app-config.js';
import { trendAnswer } from './analysis/chart-reading.js';
import { depotView, positionsFromTrades, type DepotPosition, type DepotResponse, type HeldPosition } from './analysis/depot.js';
import { watchSignals, type WatchSignal } from './analysis/depot-watch.js';
import { protectionOf } from './analysis/stops.js';
import { verdictEvidence } from './backtest/result.js';
import { readChart } from './chart-service.js';
import { readAppState, writeAppState } from './db/admin.js';
import { listJournal } from './db/journal-store.js';
import { latestPointsForAll, listSymbols, seriesForAll, symbolFacts } from './db/store.js';
import { allTrades, latestPrices } from './db/trades-store.js';
import { readCheckResult } from './depot-check-state.js';
import { fmtPriceDe } from './format.js';
import { fundHoldings } from './fund-service.js';
import { journalHeadline } from './journal.js';
import { listResearch } from './research/research.js';
import { marketDates, stockUpcoming } from './stock-history-service.js';
import { syncTradesIfStale, tradesSource, tradesSyncState } from './trades-service.js';
import { logger } from './utils/logger.js';

const DAY_MS = 86_400_000;
/** How far back the score's trend looks. */
const TREND_DAYS = 28;
/** How far ahead the dates reach. */
const AHEAD_DAYS = 30;
const FUND_TYPES = new Set(['etf', 'fund']);

/** The trailing stop the check named, as a broker runs it: its width under the highest close since the check's day. */
export function trailingSinceCheck(bars: readonly { day: string; close: number }[], day: string | null, width: number | null): number | null {
  if (!day || width === null) return null;
  const since = bars.filter((b) => b.day >= day);
  return since.length ? Math.max(...since.map((b) => b.close)) * (1 - width) : null;
}

/** Money ready to invest, entered on the depot page: private like the trades, kept under their source. */
const CASH_KEY = () => `depot.cash.${tradesSource()}`;

export async function readDepotCash(): Promise<number | null> {
  const raw = await readAppState(CASH_KEY());
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** `PUT /api/depot/cash`: null forgets it. */
export async function writeDepotCash(amountEur: number | null): Promise<void> {
  await writeAppState(CASH_KEY(), amountEur === null ? '' : String(Math.round(amountEur * 100) / 100));
}


export async function readDepot(force = false): Promise<DepotResponse> {
  await syncTradesIfStale(force);
  const [state, trades, prices, watchlist, points, journal, research, evidence] = await Promise.all([
    tradesSyncState(),
    allTrades(tradesSource()),
    latestPrices(tradesSource()),
    listSymbols('watchlist'),
    latestPointsForAll(['score.final.score', 'score.final.verdict']),
    listJournal(),
    listResearch(),
    verdictEvidence().catch(() => null),
  ]);
  if (trades.length === 0) return { ...state, view: null, evidence: null };

  const facts = await symbolFacts(watchlist);
  const model = new Map(watchlist.map((s) => {
    const p = points.get(s);
    const f = facts.get(s);
    return [s, {
      score: p?.get('score.final.score')?.value ?? null,
      verdict: p?.get('score.final.verdict')?.text ?? null,
      sector: f?.sector ?? null,
      name: f?.name ?? null,
    }];
  }));

  // The newest entry that gives the reason: linked to one of the position's
  // trades, or a purchase entry naming the stock. The journal is newest first.
  const reasons = (p: HeldPosition) => {
    const ids = new Set(p.tradeIds);
    const e = journal.find((j) => j.tradeIds.some((id) => ids.has(id))
      || (j.kind === 'buy' && p.symbol !== null && j.symbols.includes(p.symbol)));
    return e ? { entryId: e.id, day: e.day, headline: journalHeadline(e.body, 100) } : null;
  };

  // The newest thesis check of each stock; research comes newest first.
  const theses = new Map<string, { contradicted: number; total: number; at: string }>();
  for (const r of research) {
    if (r.kind !== 'thesis' || !r.data) continue;
    for (const s of r.symbols) {
      if (theses.has(s)) continue;
      theses.set(s, {
        contradicted: r.data.theses.filter((t) => t.verdict === 'contradicted').length,
        total: r.data.theses.length,
        at: r.createdAt,
      });
    }
  }

  const held = positionsFromTrades(trades);
  const listed = held.flatMap((p) => (p.symbol && model.has(p.symbol) ? [p.symbol] : []));
  const funds = held.flatMap((p) => (p.symbol && FUND_TYPES.has(p.assetType) ? [p.symbol] : []));
  const today = new Date().toISOString().slice(0, 10);
  const ahead = new Date(Date.now() + AHEAD_DAYS * DAY_MS).toISOString().slice(0, 10);
  const [config, lastCheck, fundMap, scoreSeries, market, cashEur] = await Promise.all([
    readAppConfig(), readCheckResult(),
    fundHoldings(funds).catch((e) => { logger.warn(`Fund holdings: ${(e as Error).message}`); return new Map(); }),
    seriesForAll('score.final.score', { since: new Date(Date.now() - (TREND_DAYS + 10) * DAY_MS) }),
    marketDates(today, ahead),
    readDepotCash(),
  ]);
  // The levels the last check named, as a broker would hold them: the stop where it was set, the
  // trailing stop under the highest close since that day. The chandelier, recomputed nightly, closed
  // nearly every position within weeks in the backtest (`backtest/stops.ts`) — a signal for everything.
  // Only the protection the manager chose for the stock is watched — its own stop level, where it took
  // one from the owner's note; a check from before the choice existed watches both.
  const checkDay = lastCheck?.generatedAt.slice(0, 10) ?? null;
  const chosen = new Map((lastCheck?.manager?.moves ?? []).map((m) => [m.symbol, m] as const));
  const watches = (symbol: string, kind: 'stop' | 'trailing') => {
    const protect = chosen.get(symbol)?.protect;
    return protect === undefined || protect === null || protect === kind;
  };
  const lastStops = new Map((lastCheck?.holdings ?? []).flatMap((h) => {
    const own = chosen.get(h.symbol)?.stopPrice;
    const level = own != null && h.protection && own < h.protection.close ? own : h.protection?.stop?.price;
    return level != null && watches(h.symbol, 'stop') ? [[h.symbol, level] as const] : [];
  }));
  const lastWidths = new Map((lastCheck?.holdings ?? []).flatMap((h) =>
    (h.protection?.trailing && watches(h.symbol, 'trailing') ? [[h.symbol, h.protection.trailing.width] as const] : [])));

  // Each stock held: its chart (the model's last reading, tonight's arithmetic), its dates.
  const charts = new Map<string, NonNullable<DepotPosition['chart']>>();
  const signals = new Map<string, WatchSignal[]>();
  const upcoming = new Map<string, DepotPosition['upcoming']>();
  await Promise.all(listed.map(async (s) => {
    const [c, dates] = await Promise.all([
      readChart(s).catch(() => null),
      stockUpcoming(s).catch(() => []),
    ]);
    upcoming.set(s, dates.filter((e) => e.day <= ahead).map((e) => ({ day: e.day, kind: e.kind, title: e.title, detail: e.detail ?? null })));
    if (c?.read) charts.set(s, { trend: c.read.read.trend.direction, asOf: c.read.read.asOf, summary: c.read.read.summary });
    if (!c?.analysis) return;
    const p = protectionOf(c.bars, c.analysis, c.currency);
    signals.set(s, watchSignals({
      close: p.close, currency: p.currency, trailing: trailingSinceCheck(c.bars, checkDay, lastWidths.get(s) ?? null),
      stop: lastStops.get(s) ?? null,
      score: model.get(s)?.score ?? null, falling: trendAnswer(c.analysis).tone === 'bear',
      reduceBelow: config.depotCheck.reduceBelow, price: fmtPriceDe,
    }));
  }));

  // The score about four weeks ago: the last point at or before then, else the first in the window.
  const cutoff = new Date(Date.now() - TREND_DAYS * DAY_MS).toISOString();
  const scoresBefore = new Map<string, { score: number; at: string }>();
  for (const s of listed) {
    const xs = (scoreSeries.get(s) ?? []).filter((x) => x.value !== null);
    const then = [...xs].reverse().find((x) => x.at <= cutoff) ?? xs[0];
    if (then && then.at < xs[xs.length - 1].at) scoresBefore.set(s, { score: then.value!, at: then.at });
  }

  const horizon = evidence ? Math.max(...evidence.verdicts.map((v) => v.horizon)) : null;
  return {
    ...state,
    view: depotView({ held, prices, model, reasons, theses, charts, funds: fundMap, scoresBefore, upcoming, signals, market, today, cashEur }),
    evidence: evidence && horizon !== null
      ? evidence.verdicts.filter((v) => v.horizon === horizon)
        .map((v) => ({ verdict: v.bucket, horizon: v.horizon, meanExcess: v.meanExcess, tStat: v.tStat }))
      : null,
  };
}
