/**
 * The archive, read back for one stock: the analysts' track record, our own,
 * the event timeline, the holders and the income statement as a flow.
 *
 * Everything here reads what `history-service.ts` stored; nothing fetches.
 * See the pure modules for what each view computes and why.
 */

import { trackRecord, type TrackRecord } from './analysis/analyst-accuracy.js';
import { CONSENSUS_WINDOW_DAYS, firmWordsAt, type FirmWord } from './analysis/analyst-history.js';
import { inCommonCurrency } from './analysis/evaluate.js';
import {
  callOutcomes, verdictCalls, verdictRecord, type Bar, type CallOutcome, type VerdictPoint, type VerdictRecord,
} from './analysis/verdict-record.js';
import { fxTicker, majorCurrency } from './currencies.js';
import { BENCHMARK_CURRENCY } from './data/macro.js';
import { flowFromRow, ttmFlow, type IncomeFlow } from './analysis/income-flow.js';
import { tradeKind, type Holder, type Holders } from './analysis/holders.js';
import { analystEvent, bigMoves, type Timeline, type TimelineEvent } from './analysis/timeline.js';
import type { PerplexityContext } from './data/perplexity.js';
import {
  readAnalystActions, readInsiderTransactions, readPriceBars, readPriceBarsMany, readPriceEvents, readVerdictChanges,
} from './db/history-store.js';
import {
  latestSnapshot, listDocuments, listSymbols, readFinancialsLax, readFundamentals, readSeries, readSeriesForAll,
  snapshotHistory, symbolFacts, type Series,
} from './db/store.js';
import { journalForSymbols } from './db/journal-store.js';
import { deNumber, fmtBigDe, fmtPriceDe } from './format.js';
import { JOURNAL_LABEL, journalHeadline } from './journal.js';
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

// ── Who covers the stock, and what each firm says now ───────────────────────

export interface CoverageView {
  /** Each firm's newest word from the window, highest target first; firms with a grade only last. */
  firms:      FirmWord[];
  windowDays: number;
}

/**
 * The analyst card's consensus, firm by firm. Yahoo's live figures — mean,
 * low, high, the five counts — say nothing about who is behind them; the
 * rating history does, and read up to today it is the same list the backtest
 * rebuilds a past day's consensus from.
 */
export async function analystCoverage(symbol: string): Promise<CoverageView | null> {
  const [actions, events] = await Promise.all([readAnalystActions(symbol), readPriceEvents(symbol)]);
  if (actions.length === 0) return null;
  const splits = events.filter((e) => e.kind === 'split').map((e) => ({ day: e.day, ratio: e.value }));
  // The window excludes its own day; tomorrow's window is everything up to and including today.
  const tomorrow = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
  const firms = firmWordsAt(actions, tomorrow, splits)
    .sort((a, b) => (b.target?.value ?? -Infinity) - (a.target?.value ?? -Infinity) || a.firm.localeCompare(b.firm));
  return firms.length ? { firms, windowDays: CONSENSUS_WINDOW_DAYS } : null;
}

// ── Our own verdicts' track record ──────────────────────────────────────────

const DAY_MS = 86_400_000;
const VERDICT_KEY = 'score.final.verdict';
const VERDICT_SCORE_KEY = 'score.final.score';
/** The index with its dividends, as the stocks' adjusted closes have theirs. */
const RECORD_BENCHMARK = 'SPY';

type StoredBar = { day: string; close: number; adjClose: number | null; volume: number | null };
const totalReturn = (bars: readonly StoredBar[] | undefined): Bar[] => (bars ?? []).map((b) => ({ day: b.day, close: b.adjClose ?? b.close }));
const daysBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

function verdictPoints(series: readonly Series[]): VerdictPoint[] {
  const verdicts = series.find((s) => s.key === VERDICT_KEY)?.points ?? [];
  const scores = new Map((series.find((s) => s.key === VERDICT_SCORE_KEY)?.points ?? []).map((p) => [p.at, p.value]));
  return verdicts.flatMap((p) => (p.text ? [{ at: p.at, verdict: p.text, score: scores.get(p.at) ?? null }] : []));
}

/** A listing's closes in the benchmark's currency; null when its rate is not archived. */
function inBenchmarkCurrency(bars: Bar[], currency: string, fx: Map<string, StoredBar[]>): Bar[] | null {
  if (currency === BENCHMARK_CURRENCY) return bars;
  const rate = fx.get(fxTicker(currency, BENCHMARK_CURRENCY));
  if (!rate?.length) return null;
  return inCommonCurrency(bars.map((b) => ({ date: b.day, close: b.close })), rate.map((r) => ({ date: r.day, close: r.close })))
    .map((c) => ({ day: c.date, close: c.close }));
}

/**
 * The total-return series to measure calls on, from `from` on: the index's,
 * and each stock's in the index's currency — or in its own, with `restated`
 * false, when that currency's rate is not archived. The raw bars come along
 * for the price as quoted and for what else a caller reads from them.
 */
async function returnSeries(symbols: string[], from: string): Promise<{
  bench: Bar[];
  bars: Map<string, StoredBar[]>;
  of: (symbol: string) => { series: Bar[]; restated: boolean } | null;
}> {
  const facts = await symbolFacts(symbols);
  const currencyOf = (s: string) => majorCurrency(facts.get(s.toUpperCase())?.currency) ?? BENCHMARK_CURRENCY;
  const fxTickers = [...new Set(symbols.map(currencyOf))].filter((c) => c !== BENCHMARK_CURRENCY).map((c) => fxTicker(c, BENCHMARK_CURRENCY));
  const bars = await readPriceBarsMany([...symbols, RECORD_BENCHMARK, ...fxTickers], from);
  const bench = totalReturn(bars.get(RECORD_BENCHMARK));
  return {
    bench, bars,
    of: (s) => {
      const own = totalReturn(bars.get(s.toUpperCase()));
      if (own.length === 0) return null;
      const usd = inBenchmarkCurrency(own, currencyOf(s), bars);
      return { series: usd ?? own, restated: usd !== null };
    },
  };
}

/** One stock's calls with their outcomes — against the index when its currency could be restated, else on their own. */
async function outcomesFor(
  symbols: string[], series: Map<string, Series[]>,
): Promise<{ outcomes: Map<string, CallOutcome[]>; unpriced: number; unrestated: Set<string> }> {
  const calls = new Map(symbols.map((s) => [s, verdictCalls(verdictPoints(series.get(s) ?? []))] as const));
  const first = [...calls.values()].flatMap((cs) => (cs.length ? [cs[0].day] : [])).sort()[0];
  const outcomes = new Map<string, CallOutcome[]>();
  const unrestated = new Set<string>();
  if (!first) return { outcomes, unpriced: 0, unrestated };
  // A few days before the first call: its entry is the last close at or before it.
  const { bench, bars, of } = await returnSeries(symbols, daysBefore(first, 10));
  let unpriced = 0;
  for (const s of symbols) {
    const cs = calls.get(s) ?? [];
    if (cs.length === 0) continue;
    const r = of(s);
    if (!r) { unpriced++; continue; }
    if (!r.restated) unrestated.add(s);
    // Returns from the adjusted dollar closes; the price shown is the day's own close, as quoted.
    const stored = bars.get(s.toUpperCase()) ?? [];
    const quoted = (day: string) => stored.filter((b) => b.day <= day).at(-1)?.close;
    outcomes.set(s, callOutcomes(cs, r.series, r.restated && bench.length ? bench : null)
      .map((o) => ({ ...o, price: quoted(o.day) ?? o.price })));
  }
  return { outcomes, unpriced, unrestated };
}

/**
 * Each decision measured as a call of its own: a purchase as a buy, a sale as
 * a sell, from its day to each horizon and to the newest close. Null for a
 * stock with no stored prices. Also hands back the raw bars, which the review
 * reads the situation on each day from.
 */
export async function decisionOutcomes(decisions: { key: string; symbol: string; day: string; side: 'buy' | 'sell' }[], from: string): Promise<{
  outcomes: Map<string, CallOutcome | null>;
  bars: Map<string, StoredBar[]>;
}> {
  const symbols = [...new Set(decisions.map((d) => d.symbol.toUpperCase()))];
  const outcomes = new Map<string, CallOutcome | null>();
  if (symbols.length === 0) return { outcomes, bars: new Map() };
  const { bench, bars, of } = await returnSeries(symbols, from);
  for (const d of decisions) {
    const r = of(d.symbol);
    const call = { day: d.day, verdict: d.side === 'buy' ? 'BUY' : 'SELL', from: null, score: null };
    const [o] = r ? callOutcomes([call], r.series, r.restated && bench.length ? bench : null) : [];
    outcomes.set(d.key, o ?? null);
  }
  return { outcomes, bars };
}

/** The headline fair value in force on a day — the primary models' median — and their range. */
export interface FairAtCall { value: number; low: number | null; high: number | null }

/** The composite fair value as the refresh stored it, beside each verdict. */
const FAIR_KEYS = {
  value: 'metrics.composite.primary.median', low: 'metrics.composite.primary.min', high: 'metrics.composite.primary.max',
} as const;

export interface VerdictRecordView {
  /** Each call with the fair value the page showed beside it that day; null where none was stored. */
  calls:    (CallOutcome & { fair: FairAtCall | null })[];
  /** The newest stored close, as quoted: how far the price has come since each call. */
  latest:   { day: string; price: number } | null;
  record:   VerdictRecord;
  /** The listing's currency where it is not the benchmark's. */
  currency: string | null;
  /** False when that currency's rate is not archived yet, and the calls stand without the index. */
  restated: boolean;
}

export async function verdictTrackRecord(symbol: string): Promise<VerdictRecordView | null> {
  const series = await readSeries(symbol, [VERDICT_KEY, VERDICT_SCORE_KEY]);
  const { outcomes, unrestated } = await outcomesFor([symbol], new Map([[symbol, series]]));
  const calls = outcomes.get(symbol) ?? [];
  if (calls.length === 0) return null;
  const currency = majorCurrency((await symbolFacts([symbol])).get(symbol.toUpperCase())?.currency);
  // The fair value of each call's day: the newest stored by that day's end.
  const fairSeries = await readSeries(symbol, Object.values(FAIR_KEYS));
  const pointsOf = (key: string) => fairSeries.find((x) => x.key === key)?.points ?? [];
  const asOf = (key: string, day: string) => {
    let found: number | null = null;
    for (const p of pointsOf(key)) {
      if (p.at.slice(0, 10) > day) break;
      if (p.value !== null && Number.isFinite(p.value)) found = p.value;
    }
    return found;
  };
  const fairOn = (day: string): FairAtCall | null => {
    const value = asOf(FAIR_KEYS.value, day);
    return value !== null && value > 0 ? { value, low: asOf(FAIR_KEYS.low, day), high: asOf(FAIR_KEYS.high, day) } : null;
  };
  const recent = (await readPriceBarsMany([symbol], daysBefore(new Date().toISOString().slice(0, 10), 14))).get(symbol.toUpperCase()) ?? [];
  const last = recent.at(-1);
  return {
    calls: [...calls].reverse().map((c) => ({ ...c, fair: fairOn(c.day) })),
    latest: last ? { day: last.day, price: last.close } : null,
    record: verdictRecord(outcomes, RECOMMENDATIONS),
    currency: currency && currency !== BENCHMARK_CURRENCY ? currency : null,
    restated: !unrestated.has(symbol),
  };
}

export interface VerdictRecordSummary {
  /** Every stock with a stored verdict: the watchlist and the reference universe. */
  all:        VerdictRecord;
  watchlist:  VerdictRecord;
  /** Stocks with verdicts but no archived prices yet. */
  unpriced:   number;
  computedAt: string;
}

/** The whole record, recomputed at most every few hours — prices move once a day and verdicts once a night. */
const RECORD_TTL_MS = 6 * 60 * 60_000;
let recordMemo: { at: number; value: Promise<VerdictRecordSummary> } | null = null;

export function verdictRecordSummary(fresh = false): Promise<VerdictRecordSummary> {
  if (recordMemo && !fresh && Date.now() - recordMemo.at < RECORD_TTL_MS) return recordMemo.value;
  const entry = { at: Date.now(), value: computeRecordSummary() };
  entry.value.catch(() => { if (recordMemo === entry) recordMemo = null; });
  recordMemo = entry;
  return entry.value;
}

async function computeRecordSummary(): Promise<VerdictRecordSummary> {
  const [series, watch] = await Promise.all([readSeriesForAll([VERDICT_KEY, VERDICT_SCORE_KEY]), listSymbols('watchlist')]);
  const { outcomes, unpriced } = await outcomesFor([...series.keys()], series);
  const watched = new Set(watch);
  return {
    all: verdictRecord(outcomes, RECOMMENDATIONS),
    watchlist: verdictRecord(new Map([...outcomes].filter(([s]) => watched.has(s))), RECOMMENDATIONS),
    unpriced,
    computedAt: new Date().toISOString(),
  };
}

// ── Timeline ────────────────────────────────────────────────────────────────

const dayDe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;

/** Words that make a filer a company or a fund rather than a person. */
const ENTITY = /\b(INC|LLC|LP|LTD|CORP|CO|PLC|TRUST|FUND|HOLDINGS?|PARTNERS|CAPITAL|GROUP|AG|SA|NV|GMBH)\b\.?/i;

/**
 * A filer as a person is named: SEC filings write "HOOD AMY E", surname
 * first and shouted, and a timeline of those read like a log. A person's
 * name of two to four words becomes "Amy E Hood"; a company keeps its order
 * and only loses the capitals. Mixed-case names are left be.
 */
export function personName(raw: string): string {
  if (raw !== raw.toUpperCase()) return raw;
  const cased = raw.toLowerCase().replace(/(^|[\s\-'.])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
  const words = cased.trim().split(/\s+/);
  if (ENTITY.test(raw) || words.length < 2 || words.length > 4) return cased;
  return [...words.slice(1), words[0]].join(' ');
}

const verdictRank = (v: string) => RECOMMENDATIONS.indexOf(v as (typeof RECOMMENDATIONS)[number]);
/** The longest a company takes to report a quarter: a 10-Q is due within 45 days, an annual report within 90. */
const REPORT_LAG_DAYS = 100;

export async function stockTimeline(symbol: string, days = 365): Promise<Timeline> {
  const from = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const f = await readFinancialsLax(symbol);
  // The timeline is read on the German page and in the feed: German amounts and dates.
  const money = (n: number) => fmtPriceDe(n, f?.tradingCurrency);
  const [actions, trades, priceEvents, bars, verdicts, quarters, briefs, news, journal] = await Promise.all([
    readAnalystActions(symbol),
    readInsiderTransactions(symbol),
    readPriceEvents(symbol),
    // A year more than the window: the threshold for a big move reads the year before it too.
    readPriceBars(symbol, new Date(Date.now() - (days + 365) * DAY_MS).toISOString().slice(0, 10)),
    readVerdictChanges(symbol),
    readFundamentals(symbol, 'quarter'),
    listDocuments<PerplexityContext>(symbol, 'perplexity', { limit: 30 }),
    snapshotHistory<NewsItem[]>(symbol, 'news', new Date(Date.now() - days * DAY_MS)),
    journalForSymbols([symbol], from),
  ]);

  const events: TimelineEvent[] = [];

  // My own entries: what I read, thought, bought and sold, between the events
  // that may have prompted them.
  for (const j of journal) {
    events.push({
      day: j.day, kind: 'journal', tone: j.kind === 'buy' ? 'positive' : j.kind === 'sell' ? 'negative' : 'neutral',
      title: `${JOURNAL_LABEL[j.kind]}: ${journalHeadline(j.body)}`,
      detail: j.symbols.length > 1 ? j.symbols.filter((s) => s !== symbol.toUpperCase()).join(', ') : null,
    });
  }

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
      title: `${kind === 'purchase' ? 'Kauf' : 'Verkauf'} von ${t.filer ? personName(t.filer) : 'einem Insider'}${t.relation ? ` (${t.relation})` : ''}`,
      detail: [t.shares !== null ? `${Math.round(t.shares).toLocaleString('de-DE')} Aktien` : null,
        t.value ? fmtBigDe(t.value, f?.tradingCurrency) : null].filter(Boolean).join(' · ') || null,
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
      detail: v.fromScore !== null && v.toScore !== null ? `Score ${deNumber(v.fromScore, 1)} → ${deNumber(v.toScore, 1)}` : null,
    });
  }

  // The quarter's numbers on the day they were first stored — within a night
  // of the report, since the refresh runs nightly. A quarter first stored long
  // after its end came in with the history, not with its report; it is placed
  // at the quarter's end, as a date that looks precise and is not is worse.
  const byQuarter = new Map<string, Record<string, number>>();
  const firstSeen = new Map<string, string>();
  for (const q of quarters) {
    byQuarter.set(q.periodEnd, { ...(byQuarter.get(q.periodEnd) ?? {}), [q.key]: q.value });
    if (q.key === 'epsActual') firstSeen.set(q.periodEnd, q.firstSeenAt.slice(0, 10));
  }
  for (const [end, q] of byQuarter) {
    if (q.epsActual === undefined) continue;
    const s = q.surprisePct;
    const seen = firstSeen.get(end);
    const reported = seen && (Date.parse(seen) - Date.parse(end)) / DAY_MS <= REPORT_LAG_DAYS ? seen : null;
    events.push({
      day: reported ?? end, kind: 'earnings', tone: s === undefined ? 'neutral' : s >= 0 ? 'positive' : 'negative',
      title: `Quartalszahlen bis ${dayDe(end)}: Gewinn je Aktie ${money(q.epsActual)}${q.epsEstimate !== undefined ? `, erwartet ${money(q.epsEstimate)}` : ''}`,
      detail: s !== undefined ? `Erwartung ${s >= 0 ? 'übertroffen' : 'verfehlt'} um ${deNumber(Math.abs(s) * 100, 1)} %` : null,
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

// ── What happened across the watchlist ──────────────────────────────────────

/** One stock's event, with the stock it belongs to. */
export type FeedEvent = TimelineEvent & { symbol: string; name: string | null };

export interface Feed {
  events:   FeedEvent[];
  /** Reports scheduled within `UPCOMING_DAYS`, soonest first. */
  upcoming: FeedEvent[];
  from:     string;
  symbols:  number;
}

/** How far ahead the feed lists scheduled reports. */
const UPCOMING_DAYS = 14;
/** Timelines read at once: each is a handful of indexed queries. */
const FEED_CONCURRENCY = 6;
/** The feed is read when the list opens; the archive changes once a night. */
const FEED_TTL_MS = 10 * 60_000;
const feedMemo = new Map<number, { at: number; value: Promise<Feed> }>();

/** Forget the cached feeds — after a journal entry, which should show at once and not in ten minutes. */
export function invalidateFeed(): void {
  feedMemo.clear();
}

/**
 * Every watchlist stock's timeline over the last days, on one axis — the
 * question the list raises each morning and a stock page answers only for one
 * stock: what happened. Built from the same timelines, so an event reads the
 * same here as on the stock's own page.
 */
export function watchlistFeed(days = 7, fresh = false): Promise<Feed> {
  const hit = feedMemo.get(days);
  if (hit && !fresh && Date.now() - hit.at < FEED_TTL_MS) return hit.value;
  const entry = { at: Date.now(), value: buildFeed(days) };
  entry.value.catch(() => { if (feedMemo.get(days) === entry) feedMemo.delete(days); });
  feedMemo.set(days, entry);
  return entry.value;
}

async function buildFeed(days: number): Promise<Feed> {
  const symbols = await listSymbols('watchlist');
  const facts = await symbolFacts(symbols);
  const timelines = new Map<string, Timeline>();
  const queue = [...symbols];
  await Promise.all(Array.from({ length: FEED_CONCURRENCY }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) timelines.set(s, await stockTimeline(s, days));
  }));
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + UPCOMING_DAYS * DAY_MS).toISOString().slice(0, 10);
  const tag = (symbol: string) => (e: TimelineEvent): FeedEvent => ({ ...e, symbol, name: facts.get(symbol)?.name ?? null });
  const events: FeedEvent[] = [];
  const upcoming: FeedEvent[] = [];
  for (const [symbol, t] of timelines) {
    // A stock's own timeline keeps the day the scheduled report falls on; the
    // feed only what has already happened.
    events.push(...t.events.filter((e) => e.day <= today).map(tag(symbol)));
    upcoming.push(...t.upcoming.filter((e) => e.day <= horizon).map(tag(symbol)));
  }
  return {
    events: events.sort((a, b) => b.day.localeCompare(a.day) || a.symbol.localeCompare(b.symbol)),
    upcoming: upcoming.sort((a, b) => a.day.localeCompare(b.day)),
    from: new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10),
    symbols: symbols.length,
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
