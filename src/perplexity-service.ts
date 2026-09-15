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
import { fetchPerplexity, PerplexityContext } from './data/perplexity.js';
import { readFinancialsLax, readPerplexity, writePerplexity } from './db/store.js';
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
  const { maxAgeDays } = (await readAppConfig()).perplexity;
  const stored = await readPerplexity(symbol, maxAgeDays * DAY_MS);
  if (stored) {
    logger.info(`Perplexity from store (${stored.fetchedAt.slice(0, 10)}, window ${maxAgeDays}d)`);
    return stored;
  }
  return fetchAndStore(symbol, companyName, model, apiKey, runId);
}

/** Ask Perplexity again, whatever is stored — the refresh button. */
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
): Promise<PerplexityContext> {
  const data = await fetchPerplexity(symbol, companyName, apiKey, model);
  await writePerplexity(symbol, data, runId);
  return data;
}
