/**
 * The review of my own decisions, assembled: the journal's purchases and
 * sales, the depot's trades, each measured against the S&P 500 and set beside
 * the situation it was made in. See `analysis/review.ts`.
 *
 * The trades are real holdings: develop against this in aggregate only (see CLAUDE.md).
 */

import { entryContext } from './analysis/entry-context.js';
import {
  decisionsFrom, pageDecisions, reviewOutcome, reviewPatterns, stanceOf,
  type PatternRow, type ReviewedDecision, type ReviewFilter, type ReviewQuery,
} from './analysis/review.js';
import { listResearch } from './research/research.js';
import type { ReviewCause } from './research/kinds.js';
import { listJournal } from './db/journal-store.js';
import { readSeries } from './db/store.js';
import { allTrades } from './db/trades-store.js';
import { journalHeadline } from './journal.js';
import { decisionOutcomes } from './stock-history-service.js';
import { syncTradesIfStale, tradesSource, tradesSyncState } from './trades-service.js';

const DAY_MS = 86_400_000;
/** A year before the first decision for the situation's high, low and jumps, and a margin. */
const LOOKBACK_DAYS = 400;

export interface ReviewResponse {
  configured:  boolean;
  syncedAt:    string | null;
  syncError:   string | null;
  decisions:   ReviewedDecision[];
  rows:        PatternRow[];
  notes:       string[];
  /** Decisions in stocks without stored prices, which cannot be measured. */
  unmeasured:  number;
}

/** One page of the decisions, with what the filters hold. */
export interface ReviewPage {
  configured: boolean;
  syncedAt:   string | null;
  syncError:  string | null;
  decisions:  ReviewedDecision[];
  total:      number;
  next:       number | null;
  counts:     Record<ReviewFilter, number>;
  unmeasured: number;
}

/** The groups compared, for the evaluation page. */
export interface ReviewStats {
  decisions:  number;
  unmeasured: number;
  rows:       PatternRow[];
  notes:      string[];
  /** What the newest look-back of each decision named as the cause of its result. */
  causes:     Partial<Record<ReviewCause, number>>;
}

/** The review is rebuilt at most this often; a journal entry or a sync clears it at once. */
const REVIEW_TTL_MS = 5 * 60_000;
let memo: { at: number; value: Promise<ReviewResponse> } | null = null;

/** Forget the cached review — after a journal entry, which can be a decision. */
export function invalidateReview(): void {
  memo = null;
}

function cachedReview(force: boolean): Promise<ReviewResponse> {
  if (!force && memo && Date.now() - memo.at < REVIEW_TTL_MS) return memo.value;
  const entry = { at: Date.now(), value: readReview(force) };
  entry.value.catch(() => { if (memo === entry) memo = null; });
  memo = entry;
  return entry.value;
}

export async function reviewPage(query: ReviewQuery, force = false): Promise<ReviewPage> {
  const r = await cachedReview(force);
  return {
    configured: r.configured, syncedAt: r.syncedAt, syncError: r.syncError,
    ...pageDecisions(r.decisions, query),
    unmeasured: r.unmeasured,
  };
}

export async function reviewStats(): Promise<ReviewStats> {
  const [r, reports] = await Promise.all([cachedReview(false), listResearch(undefined, 'review')]);
  // Newest first, so the first check seen of a decision is its newest.
  const seen = new Set<string>();
  const causes: ReviewStats['causes'] = {};
  for (const x of reports) {
    if (x.kind !== 'review' || !x.decision || seen.has(x.decision)) continue;
    seen.add(x.decision);
    const cause = x.data?.cause;
    if (cause) causes[cause] = (causes[cause] ?? 0) + 1;
  }
  return { decisions: r.decisions.length, unmeasured: r.unmeasured, rows: r.rows, notes: r.notes, causes };
}

export async function readReview(force = false): Promise<ReviewResponse> {
  await syncTradesIfStale(force);
  const [state, journal, trades] = await Promise.all([tradesSyncState(), listJournal(), allTrades(tradesSource())]);
  const decisions = decisionsFrom(journal, trades, (b) => journalHeadline(b, 120));
  const measurable = decisions.filter((d): d is typeof d & { symbol: string } => d.symbol !== null);
  if (measurable.length === 0) {
    return { ...state, decisions: decisions.map((d) => ({ ...d, outcome: null, situation: null })), ...reviewPatterns([]), unmeasured: decisions.length };
  }

  const first = measurable.reduce((m, d) => (d.day < m ? d.day : m), measurable[0].day);
  const from = new Date(Date.parse(first) - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const symbols = [...new Set(measurable.map((d) => d.symbol))];
  const [{ outcomes, bars }, series] = await Promise.all([
    decisionOutcomes(measurable.map((d) => ({ key: d.key, symbol: d.symbol, day: d.day, side: d.side })), from),
    Promise.all(symbols.map(async (s) => [s, await readSeries(s, ['score.final.score', 'score.final.verdict'])] as const)),
  ]);
  const model = new Map(series);
  // The model's reading as it stood at the end of the decision's day.
  const asOf = (symbol: string, key: string, day: string) => {
    let found: { value: number | null; text: string | null } | null = null;
    for (const p of model.get(symbol)?.find((x) => x.key === key)?.points ?? []) {
      if (p.at.slice(0, 10) > day) break;
      found = p;
    }
    return found;
  };

  let unmeasured = 0;
  const reviewed: ReviewedDecision[] = decisions.map((d) => {
    if (!d.symbol) { unmeasured++; return { ...d, outcome: null, situation: null }; }
    const outcome = reviewOutcome(d.day, outcomes.get(d.key) ?? null);
    if (!outcome) unmeasured++;
    const own = bars.get(d.symbol.toUpperCase()) ?? [];
    const verdict = asOf(d.symbol, 'score.final.verdict', d.day)?.text ?? null;
    const score = asOf(d.symbol, 'score.final.score', d.day)?.value ?? null;
    // The next report is only stored for now, so a past decision is read without it.
    const ctx = own.length ? entryContext(d.symbol, d.side, d.day, own, { score, verdict }, null) : null;
    return {
      ...d, outcome,
      situation: ctx?.asOf ? { flags: ctx.flags, impulse: ctx.impulse, verdict, score, stance: stanceOf(d.side, verdict) } : null,
    };
  });

  return { ...state, decisions: reviewed, ...reviewPatterns(reviewed), unmeasured };
}
