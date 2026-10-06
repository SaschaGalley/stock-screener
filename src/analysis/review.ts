/**
 * Looking back on my own decisions.
 *
 * Every purchase and sale — written down in the journal, made in the depot,
 * or both — measured the way our verdicts are: as a dated call against the
 * S&P 500, one, three, six and twelve months on and up to today. A purchase
 * was right when the stock beat the index afterwards, a sale when it lagged.
 *
 * Beside each decision stands the situation it was made in (the run-up, the
 * volume, the model's verdict that day) and the reason given for it. The
 * patterns compare the groups that matter for learning: purchases after a
 * jump against the rest, purchases against the model against those with it,
 * decisions with a reason against those without. On a few dozen decisions
 * these are hints, not findings — each group says how many it rests on.
 *
 * Pure and dependency-free so the web app can import the types.
 */

import type { JournalKind, Trade } from '../journal.js';
import { addMonths, RECORD_HORIZONS, type CallOutcome, type Leg, type RecordHorizon } from './verdict-record.js';

export type Side = 'buy' | 'sell';

export interface Decision {
  key:      string;
  day:      string;
  side:     Side;
  /** The ticker this app knows the stock by; null for one it does not. */
  symbol:   string | null;
  name:     string | null;
  /** Written down, made in the depot, or both. */
  source:   'journal' | 'trade' | 'both';
  entryId:  number | null;
  /** The reason as written, its first line. */
  reason:   string | null;
  tradeIds: number[];
}

/** How the model saw the stock that day, relative to the decision. */
export type ModelStance = 'with' | 'against' | 'neutral' | 'none';

export interface ReviewedDecision extends Decision {
  /** Null when the stock has no stored prices. */
  outcome: {
    horizons: Partial<Record<RecordHorizon, Leg>>;
    /** From the decision to the newest close. */
    since:    Leg | null;
    /** When each horizon not yet reached will be. */
    due:      Partial<Record<RecordHorizon, string>>;
  } | null;
  situation: { flags: string[]; impulse: boolean; verdict: string | null; score: number | null; stance: ModelStance } | null;
}

/** How many days apart a journal entry and a trade can be and still be one decision. */
const SAME_DECISION_DAYS = 3;
const DAY_MS = 86_400_000;
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

/**
 * Every decision once. A journal entry linked to trades, or written within a
 * few days of a trade in the same stock and direction, is one decision with
 * them, dated by the trade — the day the price was paid. Trades on one day in
 * one stock and direction are one decision, filled in tranches.
 */
export function decisionsFrom(
  entries: { id: number; day: string; kind: JournalKind; symbols: string[]; body: string; tradeIds: number[] }[],
  trades: Trade[],
  headline: (body: string) => string,
): Decision[] {
  const groups = new Map<string, { day: string; side: Side; symbol: string | null; name: string; isin: string; ids: number[]; used: boolean }>();
  for (const t of trades) {
    if (t.kind !== 'buy' && t.kind !== 'sell') continue;
    const key = `${t.day}|${t.isin}|${t.kind}`;
    const g = groups.get(key);
    if (g) g.ids.push(t.id);
    else groups.set(key, { day: t.day, side: t.kind, symbol: t.symbol, name: t.name, isin: t.isin, ids: [t.id], used: false });
  }

  const out: Decision[] = [];
  for (const e of entries) {
    if (e.kind === 'note') continue;
    const side: Side = e.kind;
    const linked = new Set(e.tradeIds);
    for (const symbol of e.symbols) {
      const g = [...groups.values()].find((x) => !x.used && x.side === side && x.symbol === symbol
        && (x.ids.some((id) => linked.has(id)) || daysApart(x.day, e.day) <= SAME_DECISION_DAYS));
      if (g) g.used = true;
      out.push({
        key: `${side}|${g?.day ?? e.day}|${symbol}|${e.id}`,
        day: g?.day ?? e.day, side, symbol, name: g?.name ?? null,
        source: g ? 'both' : 'journal', entryId: e.id, reason: headline(e.body), tradeIds: g?.ids ?? [],
      });
    }
  }
  for (const g of groups.values()) {
    if (g.used) continue;
    out.push({
      key: `${g.side}|${g.day}|${g.symbol ?? g.isin}|t${g.ids[0]}`,
      day: g.day, side: g.side, symbol: g.symbol, name: g.name,
      source: 'trade', entryId: null, reason: null, tradeIds: g.ids,
    });
  }
  return out.sort((a, b) => b.day.localeCompare(a.day) || a.key.localeCompare(b.key));
}

export function stanceOf(side: Side, verdict: string | null): ModelStance {
  if (!verdict) return 'none';
  const v = verdict.toUpperCase();
  if (v.includes('BUY')) return side === 'buy' ? 'with' : 'against';
  if (v.includes('SELL')) return side === 'sell' ? 'with' : 'against';
  return 'neutral';
}

/** A decision's outcome in the shape the review shows: the horizons reached, the rest with the day they will be measured to. */
export function reviewOutcome(day: string, o: CallOutcome | null): ReviewedDecision['outcome'] {
  if (!o) return null;
  const due: Partial<Record<RecordHorizon, string>> = {};
  for (const h of RECORD_HORIZONS) if (!o.horizons[h]) due[h] = addMonths(day, h);
  return { horizons: o.horizons, since: o.held, due };
}

/** A purchase was right when the stock beat the index afterwards, a sale when it lagged. */
export const decisionRight = (side: Side, excess: number) => (side === 'buy' ? excess > 0 : excess < 0);

export interface PatternCell {
  n:      number;
  /** Median of the stock's return over the index's. */
  median: number | null;
  /** Share of the decisions that were right. */
  right:  number | null;
}

export interface PatternRow {
  label: string;
  side:  Side;
  cells: Record<RecordHorizon, PatternCell>;
}

/** Below this many decisions a group's median is shown, but not compared. */
export const MIN_COMPARE = 5;

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function row(label: string, side: Side, ds: ReviewedDecision[]): PatternRow {
  const cells = {} as Record<RecordHorizon, PatternCell>;
  for (const h of RECORD_HORIZONS) {
    const xs = ds.flatMap((d) => {
      const e = d.outcome?.horizons[h]?.excess;
      return e === null || e === undefined ? [] : [e];
    });
    cells[h] = {
      n: xs.length,
      median: median(xs),
      right: xs.length ? xs.filter((x) => decisionRight(side, x)).length / xs.length : null,
    };
  }
  return { label, side, cells };
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`;

/**
 * The groups worth comparing, and what the comparisons say in sentences —
 * only where both sides rest on enough decisions to be read at all.
 */
export function reviewPatterns(ds: ReviewedDecision[]): { rows: PatternRow[]; notes: string[] } {
  const buys = ds.filter((d) => d.side === 'buy');
  const sells = ds.filter((d) => d.side === 'sell');
  const by = (xs: ReviewedDecision[], f: (d: ReviewedDecision) => boolean) => xs.filter(f);
  const rows = [
    row('Alle Käufe', 'buy', buys),
    row('Käufe nach Lauf, Sprung oder Volumen', 'buy', by(buys, (d) => d.situation?.impulse === true)),
    row('Käufe ohne solche Zeichen', 'buy', by(buys, (d) => d.situation?.impulse === false)),
    row('Käufe mit dem Modell (BUY)', 'buy', by(buys, (d) => d.situation?.stance === 'with')),
    row('Käufe bei HOLD', 'buy', by(buys, (d) => d.situation?.stance === 'neutral')),
    row('Käufe gegen das Modell (SELL)', 'buy', by(buys, (d) => d.situation?.stance === 'against')),
    row('Käufe mit Begründung', 'buy', by(buys, (d) => d.reason !== null)),
    row('Käufe ohne Begründung', 'buy', by(buys, (d) => d.reason === null)),
    row('Alle Verkäufe', 'sell', sells),
    row('Verkäufe nach Lauf, Sturz oder Volumen', 'sell', by(sells, (d) => d.situation?.impulse === true)),
    row('Verkäufe ohne solche Zeichen', 'sell', by(sells, (d) => d.situation?.impulse === false)),
  ];

  const notes: string[] = [];
  const find = (label: string) => rows.find((r) => r.label === label)!;
  // The longest horizon at which both groups have enough decisions.
  const compare = (a: PatternRow, b: PatternRow, say: (h: RecordHorizon, x: PatternCell, y: PatternCell) => string) => {
    const h = [...RECORD_HORIZONS].reverse().find((k) => a.cells[k].n >= MIN_COMPARE && b.cells[k].n >= MIN_COMPARE);
    if (h) notes.push(say(h, a.cells[h], b.cells[h]));
  };
  const months = (h: number) => `${h} ${h === 1 ? 'Monat' : 'Monaten'}`;
  compare(find('Käufe nach Lauf, Sprung oder Volumen'), find('Käufe ohne solche Zeichen'), (h, x, y) =>
    `Käufe nach einem Lauf, Sprung oder Volumenschub lagen nach ${months(h)} im Median ${pct(x.median!)} gegenüber dem S&P 500 (${x.n} Käufe), die übrigen ${pct(y.median!)} (${y.n}).`);
  compare(find('Käufe gegen das Modell (SELL)'), find('Käufe mit dem Modell (BUY)'), (h, x, y) =>
    `Käufe gegen das Modell-Urteil lagen nach ${months(h)} im Median ${pct(x.median!)} (${x.n}), Käufe mit ihm ${pct(y.median!)} (${y.n}).`);
  compare(find('Käufe ohne Begründung'), find('Käufe mit Begründung'), (h, x, y) =>
    `Käufe ohne aufgeschriebene Begründung lagen nach ${months(h)} im Median ${pct(x.median!)} (${x.n}), begründete ${pct(y.median!)} (${y.n}).`);
  const s = find('Alle Verkäufe');
  const sh = [...RECORD_HORIZONS].reverse().find((k) => s.cells[k].n >= MIN_COMPARE);
  if (sh) {
    const c = s.cells[sh];
    notes.push(`Nach deinen Verkäufen lag die Aktie nach ${months(sh)} im Median ${pct(c.median!)} gegenüber dem S&P 500 (${c.n} Verkäufe) — ${c.median! > 0 ? 'gehalten wäre im Schnitt besser gewesen' : 'der Verkauf hat im Schnitt nichts gekostet'}.`);
  }
  if (notes.length === 0) {
    notes.push(`Noch zu wenige Entscheidungen mit genug Abstand für einen Vergleich: jede Gruppe braucht mindestens ${MIN_COMPARE}.`);
  }
  return { rows, notes };
}

// ── The list a page at a time ────────────────────────────────────────────────

/** How a decision turned out so far: its longest measured horizon, else the time since. */
export function latestExcess(d: ReviewedDecision): number | null {
  for (const h of [...RECORD_HORIZONS].reverse()) {
    const x = d.outcome?.horizons[h]?.excess;
    if (x !== null && x !== undefined) return x;
  }
  return d.outcome?.since?.excess ?? null;
}

/** Signed so that more is better for either side: a sale gains when the stock lags. */
const merit = (d: ReviewedDecision) => {
  const x = latestExcess(d);
  return x === null ? null : d.side === 'buy' ? x : -x;
};

export type ReviewFilter = 'all' | 'buy' | 'sell' | 'right' | 'wrong' | 'impulse' | 'against' | 'unexplained';

export const REVIEW_FILTERS: { key: ReviewFilter; label: string; test: (d: ReviewedDecision) => boolean }[] = [
  { key: 'all',         label: 'Alle',                test: () => true },
  { key: 'buy',         label: 'Käufe',               test: (d) => d.side === 'buy' },
  { key: 'sell',        label: 'Verkäufe',            test: (d) => d.side === 'sell' },
  { key: 'right',       label: 'lagen richtig',       test: (d) => (merit(d) ?? 0) > 0 },
  { key: 'wrong',       label: 'lagen falsch',        test: (d) => (merit(d) ?? 0) < 0 },
  { key: 'impulse',     label: 'nach Lauf/Sprung',    test: (d) => d.situation?.impulse === true },
  { key: 'against',     label: 'gegen das Modell',    test: (d) => d.situation?.stance === 'against' },
  { key: 'unexplained', label: 'ohne Begründung',     test: (d) => d.reason === null },
];

export type ReviewSort = 'newest' | 'oldest' | 'best' | 'worst';

export const REVIEW_SORTS: { key: ReviewSort; label: string }[] = [
  { key: 'newest', label: 'Neueste zuerst' },
  { key: 'oldest', label: 'Älteste zuerst' },
  { key: 'best',   label: 'Beste zuerst' },
  { key: 'worst',  label: 'Schlechteste zuerst' },
];

export interface ReviewQuery {
  q?:      string;
  filter?: ReviewFilter;
  sort?:   ReviewSort;
  offset?: number;
  limit?:  number;
}

/** Decisions a page shows. */
export const REVIEW_PAGE = 25;

/**
 * The decisions a page shows, and how many each filter would — searched by
 * ticker, name and reason. A few hundred decisions were sent and drawn at
 * once, each a card with its own research form; the page asks for 25 now.
 */
export function pageDecisions(ds: readonly ReviewedDecision[], query: ReviewQuery): {
  decisions: ReviewedDecision[]; total: number; next: number | null; counts: Record<ReviewFilter, number>;
} {
  const q = query.q?.trim().toLowerCase() ?? '';
  const searched = q ? ds.filter((d) => [d.symbol, d.name, d.reason].some((x) => x?.toLowerCase().includes(q))) : [...ds];
  const counts = Object.fromEntries(REVIEW_FILTERS.map((f) => [f.key, searched.filter(f.test).length])) as Record<ReviewFilter, number>;
  const test = REVIEW_FILTERS.find((f) => f.key === (query.filter ?? 'all'))?.test ?? (() => true);
  const shown = searched.filter(test);
  const sort = query.sort ?? 'newest';
  const byDay = (a: ReviewedDecision, b: ReviewedDecision) => b.day.localeCompare(a.day);
  shown.sort(sort === 'newest' ? byDay
    : sort === 'oldest' ? (a, b) => -byDay(a, b)
    // Unmeasured last either way; among equals, newest first.
    : (a, b) => {
        const x = merit(a), y = merit(b);
        if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0) || byDay(a, b);
        return (sort === 'best' ? y - x : x - y) || byDay(a, b);
      });
  const start = Math.max(0, query.offset ?? 0);
  const end = Math.min(shown.length, start + Math.max(1, query.limit ?? REVIEW_PAGE));
  return { decisions: shown.slice(start, end), total: shown.length, next: end < shown.length ? end : null, counts };
}
