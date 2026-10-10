/**
 * Cached access to Perplexity research.
 *
 * Same split as `sector-medians.ts`: `data/perplexity.ts` stays pure HTTP,
 * `db/store.ts` stays pure persistence, and the policy that joins them sits
 * here — because the policy is what decides how often we pay.
 *
 * Every call is billed, and at the old 12-hour lifetime practically every
 * analysis bought a new synthesis: the nightly re-run and each "Re-run" click
 * alike. Analyst targets and the last earnings call do not move on that cycle,
 * so the lifetime is a setting now (`perplexity.maxAgeDays`, 14 days by default)
 * and every analysis honours it. The explicit refresh is the one way past it.
 */

import { readAppConfig } from './app-config.js';
import { BriefPartAnswer, fetchPerplexity, PerplexityContext, PERPLEXITY_PROMPT_HASH, reusableDebate } from './data/perplexity.js';
import { readDeepResearch, readFinancialsLax, readPerplexity, readPerplexityLax, writePerplexity } from './db/store.js';
import { DEEP_RESEARCH_MODEL } from './models.js';
import { logger } from './utils/logger.js';

export type PerplexityModel = PerplexityContext['model'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The synthesis an analysis should use: the stored one while it is inside the
 * configured window, otherwise a fresh call. Throws when that call fails — the
 * caller decides whether research is optional.
 */
export async function getPerplexityCached(
  symbol: string,
  companyName: string,
  model: PerplexityModel,
  apiKey: string,
  runId?: number | null,
): Promise<PerplexityContext> {
  const { maxAgeDays, debateMaxAgeDays } = (await readAppConfig()).perplexity;
  const stored = await readPerplexity(symbol, maxAgeDays * DAY_MS, model);
  // An answer to a different question is not a cache hit, however fresh. The
  // hash existed from the start and was never compared, so rewriting the brief
  // would have gone on serving answers to the old one for up to two weeks.
  if (stored && stored.promptHash === PERPLEXITY_PROMPT_HASH) {
    logger.info(`Perplexity from store (${stored.fetchedAt.slice(0, 10)}, window ${maxAgeDays}d)`);
    return stored;
  }
  if (stored) logger.info('Perplexity in store was written by an earlier prompt — fetching anew');
  // The facts are due; the debate of the newest brief stands in while it is young enough.
  const kept = reusableDebate(stored ?? await readPerplexityLax(symbol), model, debateMaxAgeDays * DAY_MS);
  return fetchAndStore(symbol, companyName, model, apiKey, runId, kept);
}

/**
 * The deep research report an analysis reads beside its regular brief, while
 * it is inside `perplexity.deepMaxAgeDays`. Never fetched here: it is bought
 * by hand, and only read here. Null when the analysis's own brief already is
 * deep research — the same report twice would be counted twice.
 */
export async function getDeepResearchStored(
  symbol: string, briefModel: PerplexityModel | null,
): Promise<PerplexityContext | null> {
  if (briefModel === DEEP_RESEARCH_MODEL) return null;
  const { deepMaxAgeDays } = (await readAppConfig()).perplexity;
  const stored = await readDeepResearch(symbol, deepMaxAgeDays * DAY_MS);
  if (stored) logger.info(`Deep research from store (${stored.fetchedAt.slice(0, 10)}, window ${deepMaxAgeDays}d)`);
  return stored;
}

/** Ask Perplexity again, whatever is stored — the refresh button, both parts of the brief. */
export async function refreshPerplexity(
  symbol: string,
  model: PerplexityModel,
  apiKey: string,
): Promise<PerplexityContext> {
  // Lax: a stale snapshot still carries the company name, which is all the
  // prompt needs from it.
  const financials = await readFinancialsLax(symbol);
  return fetchAndStore(symbol, financials?.companyName ?? symbol, model, apiKey);
}

async function fetchAndStore(
  symbol: string,
  companyName: string,
  model: PerplexityModel,
  apiKey: string,
  runId?: number | null,
  keptDebate: BriefPartAnswer | null = null,
): Promise<PerplexityContext> {
  const data = await fetchPerplexity(symbol, companyName, apiKey, model, keptDebate);
  await writePerplexity(symbol, data, runId);
  return data;
}
