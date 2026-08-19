/**
 * The three things the pipeline does to one symbol, each on its own.
 *
 * Split out of `scheduler.ts` because there are now two callers with different
 * shapes: the in-process scheduler runs all three back to back for one symbol,
 * while the Hatchet pipeline runs them as separate tasks so each can carry its
 * own rate limit, concurrency cap and retry budget. Both must apply the same
 * rules — hence one definition here rather than a copy on each side.
 *
 * Every step reports rather than throws. A dead ticker costs its own symbol its
 * nightly update and nothing else, which is why the outcome is a `JobStepResult`
 * with a status instead of an exception.
 */

import { getConfig } from '../config.js';
import { AppConfig, isWatched } from '../app-config.js';
import { JobStep, JobStepResult, StepStatus } from '../db/admin.js';
import { ANALYSIS_VERSION, listAnalyses, listSymbols, readFinancialsLax } from '../db/store.js';
import { refreshStockData } from '../refresh.js';
import { runAnalysis } from '../cli.js';
import { distillHintsFor, syncDistillBriefing } from '../distill-service.js';
import { logger } from '../utils/logger.js';
import { query } from '../db/client.js';

/** Symbols the nightly run covers, in the order it will walk them. */
export async function scheduledSymbols(config: AppConfig): Promise<string[]> {
  return (await listSymbols()).filter((s) => isWatched(config, s)).sort();
}

// ── Staleness ────────────────────────────────────────────────────────────────

/**
 * Age of the newest stored verdict across *all* flag combinations, or null when
 * the stock was never analysed.
 *
 * Deliberately combination-blind: the question the schedule asks is "does this
 * stock have a recent verdict?", not "has this exact model run recently?".
 * Keying it to the configured model would re-analyse the whole watchlist the
 * day someone switches models.
 */
export async function newestAnalysisAgeDays(symbol: string): Promise<number | null> {
  const entries = await listAnalyses(symbol);
  if (entries.length === 0) return null;
  const newest = entries
    .map((e) => new Date(e.generatedAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  if (newest === undefined) return null;
  return (Date.now() - newest) / 86_400_000;
}

/**
 * The same answer for every symbol at once.
 *
 * The per-symbol version costs one query each, which the old serial loop could
 * absorb; deciding a fan-out up front cannot. The rows are reduced in JS rather
 * than by the database on purpose: `generatedAt` is a JSON string that a bad
 * write could leave unparseable, and in SQL a failed cast takes down the whole
 * query, where here it just drops that row — which is what the single-symbol
 * path has always done.
 */
export async function newestAnalysisAges(): Promise<Map<string, number>> {
  const res = await query<{ symbol: string; produced_at: Date; generated_at: string | null; has_flags: boolean }>(
    `SELECT s.symbol, d.produced_at,
            d.data->>'generatedAt' AS generated_at,
            (d.data ? 'flags')     AS has_flags
       FROM documents d
       JOIN symbols   s ON s.id = d.symbol_id
      WHERE d.kind = 'verdict' AND d.schema_ver = $1`,
    [ANALYSIS_VERSION],
  );

  const newest = new Map<string, number>();
  for (const row of res.rows) {
    if (!row.has_flags) continue;
    const at = new Date(row.generated_at ?? row.produced_at.toISOString()).getTime();
    if (!Number.isFinite(at)) continue;
    const seen = newest.get(row.symbol);
    if (seen === undefined || at > seen) newest.set(row.symbol, at);
  }

  const ages = new Map<string, number>();
  for (const [symbol, at] of newest) ages.set(symbol, (Date.now() - at) / 86_400_000);
  return ages;
}

/** Whether a verdict of this age needs redoing under the configured limit. */
export function isVerdictStale(config: AppConfig, ageDays: number | null): boolean {
  return ageDays === null || ageDays > config.steps.analysis.maxAgeDays;
}

/**
 * The search providers to use for one symbol, escalated when the symbol has no
 * sell-side coverage.
 *
 * The nightly defaults are deliberately cheap: no search, no Perplexity. For a
 * covered stock that is fine — the analyst consensus is an independent check on
 * the computed models. For an uncovered one it is not: the models become the
 * only voice in the room, and any error in their shared inputs goes unchallenged
 * all the way to the verdict.
 *
 * Reads coverage from the stored financials, which the data step has just
 * refreshed. A missing or unreadable payload escalates too — not knowing whether
 * a symbol is covered is not a reason to assume it is.
 */
export async function escalateSearchIfUncovered(config: AppConfig, symbol: string): Promise<string[]> {
  const { search, searchWhenUncovered, uncoveredSearchProvider } = config.steps.analysis;
  if (!searchWhenUncovered || search.length > 0) return search;

  let covered: boolean;
  try {
    const f = await readFinancialsLax(symbol);
    const ratings = (f?.analystStrongBuy ?? 0) + (f?.analystBuy ?? 0) + (f?.analystHold ?? 0)
      + (f?.analystSell ?? 0) + (f?.analystStrongSell ?? 0);
    covered = ratings > 0 || (f?.targetMeanPrice ?? null) !== null;
  } catch {
    covered = false;
  }
  if (covered) return search;

  logger.info(`${symbol}: no analyst coverage — escalating to search "${uncoveredSearchProvider}" for this symbol.`);
  return [uncoveredSearchProvider];
}

// ── Steps ────────────────────────────────────────────────────────────────────

function result(step: JobStep, status: StepStatus, detail: string, ms: number): JobStepResult {
  return { step, status, detail, ms };
}

async function timed(fn: () => Promise<string>): Promise<{ detail: string; ms: number }> {
  const started = Date.now();
  const detail = await fn();
  return { detail, ms: Date.now() - started };
}

/** Yahoo/Finnhub/FRED refresh + technicals + models. */
export async function runDataStep(
  config: AppConfig, symbol: string, runId: number,
): Promise<JobStepResult> {
  if (!config.steps.data.enabled) return result('data', 'skipped', 'step disabled', 0);
  try {
    const { detail, ms } = await timed(async () => {
      // Distill is its own step — skip the courtesy fetch inside the data
      // refresh so a symbol never hits Distill twice in one run.
      const data = await refreshStockData(symbol, { includeDistill: false, runId });
      return `$${data.financials.price.toFixed(2)} · ${data.news.length} news`;
    });
    return result('data', 'ok', detail, ms);
  } catch (e) {
    return result('data', 'failed', (e as Error).message, 0);
  }
}

/** Distill briefing: refresh (POST, generates) or fetch (GET, free). */
export async function runDistillStep(
  config: AppConfig, symbol: string, _runId: number,
): Promise<JobStepResult> {
  const cfg = getConfig();
  if (!config.steps.distill.enabled) return result('distill', 'skipped', 'step disabled', 0);
  if (!cfg.distillApiKey) return result('distill', 'skipped', 'DISTILL_API_KEY not set', 0);

  try {
    const { detail, ms } = await timed(async () => {
      const financials = await readFinancialsLax(symbol);
      const res = await syncDistillBriefing(
        distillHintsFor(symbol, financials),
        cfg.distillApiKey!,
        cfg.distillApiUrl,
        cfg.distillBriefingTypeId,
        config.steps.distill.mode,
      );
      const state = res.cacheState ? `${res.cacheState}` : 'fetched';
      const cost = res.distillCostUsd > 0 ? ` · $${res.distillCostUsd.toFixed(4)}` : '';
      return `${res.mode}: ${state}${res.bundle.briefing ? '' : ', no briefing'}${cost}`;
    });
    return result('distill', 'ok', detail, ms);
  } catch (e) {
    return result('distill', 'failed', (e as Error).message, 0);
  }
}

/**
 * Re-analyse, but only when the stored verdict has aged past the limit.
 *
 * `ageDays` is passed in rather than looked up so the Hatchet parent can decide
 * the whole fan-out from one query; `undefined` means "work it out yourself",
 * which is what the in-process scheduler does.
 */
export async function runAnalysisStep(
  config: AppConfig, symbol: string, runId: number, ageDays?: number | null,
): Promise<JobStepResult> {
  const analysis = config.steps.analysis;
  if (!analysis.enabled) return result('analysis', 'skipped', 'step disabled', 0);

  const age = ageDays === undefined ? await newestAnalysisAgeDays(symbol) : ageDays;
  if (!isVerdictStale(config, age)) {
    return result('analysis', 'skipped',
      `verdict is ${age!.toFixed(1)}d old (limit ${analysis.maxAgeDays}d)`, 0);
  }

  // With no sell-side coverage the verdict would rest entirely on our own
  // computed models — no consensus to triangulate against, and on the shipped
  // defaults no web context either. Spend one search call to buy back an
  // independent input rather than analyse in a closed loop.
  const search = await escalateSearchIfUncovered(config, symbol);

  try {
    const { detail, ms } = await timed(async () => {
      const { result: r } = await runAnalysis({
        symbol,
        model:  analysis.model,
        search,
        pplx:   analysis.pplx,
        runId,
        // A stored verdict has no TTL, so a plain run would serve the very one
        // we consider stale. Force means force.
        force:  true,
      });
      return `${r.llmAnalysis.recommendation} · score ${r.llmAnalysis.score}/10 · ${r.provider}`;
    });
    return result('analysis', 'ok',
      `${age === null ? 'never analysed' : `${age.toFixed(1)}d old`} → ${detail}`, ms);
  } catch (e) {
    return result('analysis', 'failed', (e as Error).message, 0);
  }
}
