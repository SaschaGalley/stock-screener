/**
 * Per-symbol time series of the numbers worth watching drift on.
 *
 * Everything else in the cache is a *snapshot that gets overwritten* —
 * financials.json holds today's price, analyses/<hash>.json holds the newest
 * verdict for that flag combination. That answers "where does this stock stand
 * now?" but throws away "where was it three weeks ago?", which is the question
 * a screener run nightly is actually good at answering.
 *
 * So each pipeline step appends a point here instead of only overwriting. Two
 * sources feed it:
 *   - `analysis` — written when an LLM verdict is produced (score, label, the
 *     model's own fair-value range).
 *   - `data`     — written when the data layer refreshes (price, analyst target,
 *     recomputed composite fair value). No LLM involved, so no verdict fields.
 *
 * Points are deduplicated per (source, calendar day): the last write of a day
 * wins. A nightly run therefore produces exactly one point per source per day,
 * while a user hammering the refresh button doesn't distort the series.
 */

import { StockFinancials } from './types.js';
import { AnalysisResult } from './types.js';
import { ComputedMetrics } from './analysis/computeMetrics.js';

export type HistorySource = 'analysis' | 'data';

export interface HistoryPoint {
  /** ISO timestamp of the write. */
  at:          string;
  source:      HistorySource;
  price:       number | null;
  marketCap:   number | null;
  peRatio:     number | null;
  /** Consensus analyst mean target, and its distance from the price in %. */
  targetMean:      number | null;
  targetUpsidePct: number | null;
  /** Composite primary-tier fair value (median), and its margin of safety in %. */
  compositeFairValue:  number | null;
  compositeUpsidePct:  number | null;
  /** LLM verdict — only on `analysis` points. */
  aiScore:           number | null;
  recommendation:    string | null;
  fairValueEstimate: string | null;
  model:             string | null;
}

/** Cap the series so a long-lived cache can't grow without bound. ~4 years of
 *  daily points from both sources. */
export const HISTORY_MAX_POINTS = 3000;
export const HISTORY_VERSION = 1;

function pct(from: number | null | undefined, to: number | null | undefined): number | null {
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Shared numeric core of both point kinds. */
function basePoint(
  f: StockFinancials,
  composite: ComputedMetrics['composite'] | null,
  source: HistorySource,
): HistoryPoint {
  const price = num(f.price);
  const compositeFairValue = num(composite?.primary?.median);
  return {
    at:        new Date().toISOString(),
    source,
    price,
    marketCap: num(f.marketCap),
    peRatio:   num(f.peRatio),
    targetMean:      num(f.targetMeanPrice),
    targetUpsidePct: pct(price, num(f.targetMeanPrice)),
    compositeFairValue,
    // The composite already computes (median − price) / price; fall back to
    // deriving it so a tier without marginOfSafety still charts.
    compositeUpsidePct: composite?.primary?.marginOfSafety != null
      ? composite.primary.marginOfSafety * 100
      : pct(price, compositeFairValue),
    aiScore:           null,
    recommendation:    null,
    fairValueEstimate: null,
    model:             null,
  };
}

/** Snapshot after a data-layer refresh — market numbers only, no verdict. */
export function historyPointFromData(
  financials: StockFinancials,
  metrics: ComputedMetrics | null,
): HistoryPoint {
  return basePoint(financials, metrics?.composite ?? null, 'data');
}

/** Snapshot after an LLM analysis — market numbers plus the verdict. */
export function historyPointFromAnalysis(result: AnalysisResult): HistoryPoint {
  return {
    ...basePoint(result.financials, result.composite, 'analysis'),
    aiScore:           num(result.llmAnalysis.score),
    recommendation:    result.llmAnalysis.recommendation,
    fairValueEstimate: result.llmAnalysis.fairValueEstimate,
    model:             result.provider,
  };
}

/**
 * Merge a new point into a series: same source on the same calendar day
 * replaces, everything else appends. Kept pure so the cache layer only has to
 * read, call this, and write.
 */
export function mergeHistoryPoint(series: HistoryPoint[], point: HistoryPoint): HistoryPoint[] {
  const day = point.at.slice(0, 10);
  const kept = series.filter((p) => !(p.source === point.source && p.at.slice(0, 10) === day));
  kept.push(point);
  kept.sort((a, b) => a.at.localeCompare(b.at));
  return kept.length > HISTORY_MAX_POINTS ? kept.slice(kept.length - HISTORY_MAX_POINTS) : kept;
}

/** Newest point carrying an LLM verdict, or null when never analysed. */
export function latestVerdict(series: HistoryPoint[]): HistoryPoint | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].aiScore !== null) return series[i];
  }
  return null;
}
