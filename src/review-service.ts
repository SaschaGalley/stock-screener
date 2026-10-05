/**
 * The review of my own decisions, assembled: the journal's purchases and
 * sales, the depot's trades, each measured against the S&P 500 and set beside
 * the situation it was made in. See `analysis/review.ts`.
 *
 * The trades are real holdings: develop against this in aggregate only (see CLAUDE.md).
 */

import { entryContext } from './analysis/entry-context.js';
import {
  decisionsFrom, reviewOutcome, reviewPatterns, stanceOf, type ReviewedDecision, type PatternRow,
} from './analysis/review.js';
import { listJournal } from './db/journal-store.js';
import { readSeries } from './db/store.js';
import { allTrades } from './db/trades-store.js';
import { journalHeadline } from './journal.js';
import { decisionOutcomes } from './stock-history-service.js';
import { syncTradesIfStale, tradesSyncState } from './trades-service.js';

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

export async function readReview(force = false): Promise<ReviewResponse> {
  await syncTradesIfStale(force);
  const [state, journal, trades] = await Promise.all([tradesSyncState(), listJournal(), allTrades('umsatz')]);
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
