/**
 * The archive, read back for one stock: the analysts' track record, the event
 * timeline, the holders and the income statement as a flow.
 *
 * Everything here reads what `history-service.ts` stored; nothing fetches.
 * See the pure modules for what each view computes and why.
 */

import { trackRecord, type TrackRecord } from './analysis/analyst-accuracy.js';
import { flowFromRow, ttmFlow, type IncomeFlow } from './analysis/income-flow.js';
import { tradeKind, type Holder, type Holders } from './analysis/holders.js';
import { analystEvent, bigMoves, type Timeline, type TimelineEvent } from './analysis/timeline.js';
import type { PerplexityContext } from './data/perplexity.js';
import {
  readAnalystActions, readInsiderTransactions, readPriceBars, readPriceEvents, readVerdictChanges,
} from './db/history-store.js';
import {
  latestSnapshot, listDocuments, readFinancialsLax, readFundamentals, snapshotHistory,
} from './db/store.js';
import { fmtBig, fmtPrice } from './format.js';
import type { NewsItem } from './types.js';
import { RECOMMENDATIONS } from './verdict.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Analysts' track record ──────────────────────────────────────────────────

/** The record without every single outcome — the page shows firms, totals and the consensus line. */
export type TrackRecordView = Omit<TrackRecord, 'outcomes'> & { targets: number; pending: number };

export async function analystTrackRecord(symbol: string): Promise<TrackRecordView | null> {
  const [actions, bars, events] = await Promise.all([
    readAnalystActions(symbol), readPriceBars(symbol), readPriceEvents(symbol),
  ]);
  if (actions.length === 0 || bars.length === 0) return null;
  const splits = events.filter((e) => e.kind === 'split').map((e) => ({ day: e.day, ratio: e.value }));
  const { outcomes, ...rest } = trackRecord(actions, bars.map((b) => ({ day: b.day, close: b.close })), splits);
  return { ...rest, targets: outcomes.length, pending: outcomes.filter((o) => o.error === null).length };
}

// ── Timeline ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const verdictRank = (v: string) => RECOMMENDATIONS.indexOf(v as (typeof RECOMMENDATIONS)[number]);

export async function stockTimeline(symbol: string, days = 365): Promise<Timeline> {
  const from = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const f = await readFinancialsLax(symbol);
  const money = (n: number) => fmtPrice(n, f?.tradingCurrency);
  const [actions, trades, priceEvents, bars, verdicts, quarters, briefs, news] = await Promise.all([
    readAnalystActions(symbol),
    readInsiderTransactions(symbol),
    readPriceEvents(symbol),
    // A year more than the window: the threshold for a big move reads the year before it too.
    readPriceBars(symbol, new Date(Date.now() - (days + 365) * DAY_MS).toISOString().slice(0, 10)),
    readVerdictChanges(symbol),
    readFundamentals(symbol, 'quarter'),
    listDocuments<PerplexityContext>(symbol, 'perplexity', { limit: 30 }),
    snapshotHistory<NewsItem[]>(symbol, 'news', new Date(Date.now() - days * DAY_MS)),
  ]);

  const events: TimelineEvent[] = [];

  for (const a of actions) {
    const e = analystEvent(a, money);
    if (e) events.push(e);
  }

  for (const t of trades) {
    const kind = tradeKind(t.description);
    // Grants, gifts and option exercises are compensation, not a view on the stock.
    if (!t.tradedOn || kind === 'other') continue;
    events.push({
      day: t.tradedOn, kind: 'insider', tone: kind === 'purchase' ? 'positive' : 'negative',
      title: `${t.filer ?? 'Insider'}${t.relation ? ` (${t.relation})` : ''}: ${kind === 'purchase' ? 'Kauf' : 'Verkauf'}`,
      detail: [t.shares !== null ? `${Math.round(t.shares).toLocaleString('de-DE')} Aktien` : null,
        t.value ? fmtBig(t.value, f?.tradingCurrency) : null].filter(Boolean).join(' · ') || null,
    });
  }

  for (const p of priceEvents) {
    events.push(p.kind === 'split'
      ? { day: p.day, kind: 'dividend', tone: 'neutral', title: `Aktiensplit ${p.value >= 1 ? `${p.value}:1` : `1:${Math.round(1 / p.value)}`}` }
      : { day: p.day, kind: 'dividend', tone: 'neutral', title: `Dividende ${money(p.value)}`, detail: 'Ex-Tag' });
  }

  events.push(...bigMoves(bars, from));

  for (const v of verdicts) {
    const better = verdictRank(v.to) < verdictRank(v.from);
    events.push({
      day: v.at.slice(0, 10), kind: 'verdict', tone: better ? 'positive' : 'negative',
      title: `Urteil ${v.from} → ${v.to}`,
      detail: v.fromScore !== null && v.toScore !== null ? `Score ${v.fromScore.toFixed(1)} → ${v.toScore.toFixed(1)}` : null,
    });
  }

  // The quarter's numbers, placed at the quarter's end: the report day itself
  // is not archived, and a date that looks precise and is not is worse.
  const byQuarter = new Map<string, Record<string, number>>();
  for (const q of quarters) byQuarter.set(q.periodEnd, { ...(byQuarter.get(q.periodEnd) ?? {}), [q.key]: q.value });
  for (const [end, q] of byQuarter) {
    if (q.epsActual === undefined) continue;
    const s = q.surprisePct;
    events.push({
      day: end, kind: 'earnings', tone: s === undefined ? 'neutral' : s >= 0 ? 'positive' : 'negative',
      title: `Quartal bis ${end}: EPS ${money(q.epsActual)}${q.epsEstimate !== undefined ? ` vs. ${money(q.epsEstimate)} erwartet` : ''}`,
      detail: s !== undefined ? `${s >= 0 ? 'Übertroffen' : 'Verfehlt'} um ${(Math.abs(s) * 100).toFixed(1)} %` : null,
    });
  }

  // Dated findings from every brief on file, each once.
  const seen = new Set<string>();
  for (const doc of briefs) {
    const fi = doc.data?.findings;
    if (!fi) continue;
    for (const [list, tone] of [[fi.events, 'neutral'], [fi.bearEvidence, 'negative']] as const) {
      for (const x of list ?? []) {
        if (!x.date || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) continue;
        const key = `${x.date}|${x.what}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({
          day: x.date, kind: 'event', tone, title: x.what,
          detail: x.independent ? 'unabhängige Quelle' : 'Unternehmensquelle', url: x.source,
        });
      }
    }
  }

  const urls = new Set<string>();
  for (const snap of news) {
    for (const n of snap.data ?? []) {
      if (!n.url || urls.has(n.url) || !n.datetime) continue;
      urls.add(n.url);
      events.push({
        day: new Date(n.datetime * 1000).toISOString().slice(0, 10), kind: 'news', tone: 'neutral',
        title: n.headline, detail: n.source || null, url: n.url,
      });
    }
  }

  const upcoming: TimelineEvent[] = f?.nextEarningsDate && f.nextEarningsDate >= new Date().toISOString().slice(0, 10)
    ? [{ day: f.nextEarningsDate, kind: 'earnings', tone: 'neutral', title: 'Nächste Quartalszahlen' }]
    : [];

  return {
    events: events.filter((e) => e.day >= from).sort((a, b) => b.day.localeCompare(a.day)),
    upcoming, from,
  };
}

// ── Holders ─────────────────────────────────────────────────────────────────

const num = (v: any): number | null => {
  const x = v && typeof v === 'object' && 'raw' in v ? v.raw : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
};
const iso = (v: any): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const holdersOf = (module: any): Holder[] => (module?.ownershipList ?? []).flatMap((h: any) => (typeof h?.organization === 'string' ? [{
  organization: h.organization, pctHeld: num(h.pctHeld), position: num(h.position), value: num(h.value),
  pctChange: num(h.pctChange), reportDate: iso(h.reportDate),
}] : []));

export async function stockHolders(symbol: string): Promise<Holders | null> {
  const [latest, archive, trades] = await Promise.all([
    latestSnapshot<any>(symbol, 'yahoo_holders'),
    snapshotHistory<any>(symbol, 'yahoo_holders'),
    readInsiderTransactions(symbol),
  ]);
  if (!latest && trades.length === 0) return null;
  const h = latest?.data ?? {};
  const mhb = h.majorHoldersBreakdown ?? {};
  const nsa = h.netSharePurchaseActivity;

  // Each top institution's stake as the archived reports recorded it, one
  // point per report date.
  const series = new Map<string, Map<string, number>>();
  for (const snap of archive) {
    for (const x of holdersOf(snap.data?.institutionOwnership)) {
      if (x.pctHeld === null || !x.reportDate) continue;
      const s = series.get(x.organization) ?? new Map<string, number>();
      s.set(x.reportDate, x.pctHeld);
      series.set(x.organization, s);
    }
  }

  return {
    asOf: latest?.lastSeenAt ?? null,
    breakdown: {
      insiders: num(mhb.insidersPercentHeld), institutions: num(mhb.institutionsPercentHeld),
      institutionsFloat: num(mhb.institutionsFloatPercentHeld), institutionsCount: num(mhb.institutionsCount),
    },
    institutions: holdersOf(h.institutionOwnership),
    funds: holdersOf(h.fundOwnership),
    insiders: (h.insiderHolders?.holders ?? []).flatMap((x: any) => (typeof x?.name === 'string' ? [{
      name: x.name, relation: x.relation ?? null, lastTransaction: x.transactionDescription ?? null,
      lastTransactionOn: iso(x.latestTransDate), sharesDirect: num(x.positionDirect),
    }] : [])),
    netActivity: nsa ? {
      buys: num(nsa.buyInfoCount), sells: num(nsa.sellInfoCount), netShares: num(nsa.netInfoShares),
      netPercentInsiderShares: num(nsa.netPercentInsiderShares), netInstitutionalBuyingPercent: num(nsa.netInstBuyingPercent),
    } : null,
    trades: trades.slice(0, 60).map((t) => ({ ...t, kind: tradeKind(t.description) })),
    history: [...series.entries()].map(([organization, s]) => ({
      organization, points: [...s.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, pctHeld]) => ({ day, pctHeld })),
    })).filter((x) => x.points.length > 1),
  };
}

// ── Income statement as a flow ──────────────────────────────────────────────

export interface IncomeFlows {
  /** The statements' own currency — reported, not converted. */
  currency: string | null;
  ttm:      IncomeFlow | null;
  /** Every fiscal year on file, oldest first. */
  years:    IncomeFlow[];
}

export async function incomeFlows(symbol: string): Promise<IncomeFlows | null> {
  const [st, f] = await Promise.all([latestSnapshot<any>(symbol, 'yahoo_statements'), readFinancialsLax(symbol)]);
  if (!st) return null;
  const annual: any[] = st.data?.annual?.financials ?? [];
  const years = annual
    .map((row) => flowFromRow(row, 'annual'))
    .filter((x): x is IncomeFlow => x !== null)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  return {
    currency: f?.financialCurrency ?? f?.tradingCurrency ?? null,
    ttm: ttmFlow(st.data?.quarterly?.financials ?? []),
    years,
  };
}
