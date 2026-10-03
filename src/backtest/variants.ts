/**
 * The score as it would be under a different rule, on the same months.
 *
 * A variant is the published score assembled again from the same criterion
 * points, the same trust and the same caps — nothing read again, nothing
 * recalibrated — with one thing changed. Whatever it does differently is the
 * change, not the data. The first question asked this way: the conviction
 * stretch, which multiplies a score's distance from neutral by up to 1.6 when
 * the pillars agree, and whose top — a score of 8 or more — trailed the
 * average stock over the three and six months after.
 *
 * The verdict bands were set with the stretch in place; without it fewer
 * scores reach them. So the rank — the IC, the tenths — is the comparison
 * that means the same in every variant, and the verdicts are shown with how
 * many stocks each held.
 */

import { assembleScore, capVerdict, WEIGHTS } from '../analysis/score.js';
import { verdictForScore } from '../verdict.js';
import type { SignalPoint } from '../analysis/evaluate.js';
import { criteriaOf, type ScoredRow } from './weights.js';

export interface Variant {
  key:     string;
  label:   string;
  /** Share of the conviction stretch applied: 1 as published, 0 none. */
  stretch: number;
  /**
   * No STRONG BUY while the momentum pillar sits below this — it becomes a
   * BUY; a STRONG SELL is left alone. The top of the score held to the
   * market's confirmation. Derived from the study of the
   * top tenth (`top-decile.ts`), whose laggards were the ones the price had
   * not followed — measured on the same years it was found in, so read as a
   * candidate, not as a test.
   */
  momentumFloor?: number;
}

/** The published rule first: the variants are read against it, assembled the same way. */
export const VARIANTS: readonly Variant[] = [
  { key: 'published',     label: 'Wie veröffentlicht',        stretch: 1 },
  { key: 'half-stretch',  label: 'Halbe Conviction-Streckung', stretch: 0.5 },
  { key: 'no-stretch',    label: 'Ohne Conviction-Streckung',  stretch: 0 },
  { key: 'momentum-floor', label: 'STRONG BUY nur mit Momentum ≥ 5', stretch: 1, momentumFloor: 5 },
];

/** Each row's score and capped verdict under a variant, as signals the evaluation reads. */
export function variantSignals(rows: readonly ScoredRow[], v: Variant): { score: Map<string, SignalPoint[]>; verdict: Map<string, SignalPoint[]> } {
  const score = new Map<string, SignalPoint[]>();
  const verdict = new Map<string, SignalPoint[]>();
  const push = (m: Map<string, SignalPoint[]>, symbol: string, p: SignalPoint) => {
    const list = m.get(symbol);
    if (list) list.push(p); else m.set(symbol, [p]);
  };
  for (const r of rows) {
    const a = assembleScore(criteriaOf(r), r.trust, WEIGHTS, v.stretch);
    const momentum = a.pillars.find((p) => p.key === 'momentum')?.score ?? null;
    let text = capVerdict(verdictForScore(a.score), r.caps);
    if (text === 'STRONG BUY' && v.momentumFloor !== undefined && momentum !== null && momentum < v.momentumFloor) text = 'BUY';
    push(score, r.symbol, { at: r.at, value: a.score });
    push(verdict, r.symbol, { at: r.at, value: null, text });
  }
  return { score, verdict };
}
