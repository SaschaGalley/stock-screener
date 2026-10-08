/**
 * The depot view, assembled: the trades and euro prices from umsatz, the
 * watchlist's scores, the journal's reasons, the thesis checks and the
 * backtest's record of the verdicts. See `analysis/depot.ts` for what it
 * computes and why it stops short of target weights.
 *
 * Real holdings: develop against it in aggregate only (see CLAUDE.md).
 */

import { depotView, positionsFromTrades, type DepotResponse, type HeldPosition } from './analysis/depot.js';
import { verdictEvidence } from './backtest/result.js';
import { listJournal } from './db/journal-store.js';
import { latestPointsForAll, listSymbols, symbolFacts } from './db/store.js';
import { allTrades, latestPrices } from './db/trades-store.js';
import { journalHeadline } from './journal.js';
import { listResearch } from './research/research.js';
import { syncTradesIfStale, tradesSource, tradesSyncState } from './trades-service.js';


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

  const horizon = evidence ? Math.max(...evidence.verdicts.map((v) => v.horizon)) : null;
  return {
    ...state,
    view: depotView({ held: positionsFromTrades(trades), prices, model, reasons, theses }),
    evidence: evidence && horizon !== null
      ? evidence.verdicts.filter((v) => v.horizon === horizon)
        .map((v) => ({ verdict: v.bucket, horizon: v.horizon, meanExcess: v.meanExcess, tStat: v.tStat }))
      : null,
  };
}
