/**
 * What the pipeline is allowed to consume, and how fast.
 *
 * Two different primitives, for two different questions:
 *
 *   rate limit  — "how many calls per minute may we make to this API?"
 *                 A property of the third party, not of our run. Declared once
 *                 and global, so adding symbols to the watchlist changes
 *                 nothing here: the queue simply takes longer to drain.
 *
 *   concurrency — "how many of these may be in flight at once?"
 *                 A property of the thing being called. Distill may reach a
 *                 machine at home running Ollama, which does one at a time.
 *
 * Units matter as much as the limits. One data step makes two Finnhub calls —
 * `getBasicFinancials` and `getNews` — so it spends two units, and a 60/minute
 * budget is 30 symbols per minute rather than 60.
 */

import { RateLimitDuration } from '@hatchet-dev/typescript-sdk';

import { logger } from '../utils/logger.js';
import { getHatchet } from './client.js';

/** Rate-limit keys, declared server-side once per worker boot. */
export const RATE_LIMITS = [
  // Free tier is 60 requests/minute.
  { key: 'finnhub', limit: 60, duration: RateLimitDuration.MINUTE },
  // No published limit, but it throttles hard and silently. Deliberately
  // conservative, and separate from Finnhub so a Yahoo slowdown does not eat
  // into a budget that has nothing to do with it.
  { key: 'yahoo',   limit: 30, duration: RateLimitDuration.MINUTE },
] as const;

/** Finnhub calls one data step makes: basic financials + news. */
export const FINNHUB_UNITS_PER_SYMBOL = 2;
export const YAHOO_UNITS_PER_SYMBOL   = 1;

/** How many symbols may sit in each stage at once. */
export const DISTILL_CONCURRENCY  = 1;
export const ANALYSIS_CONCURRENCY = 3;

/**
 * Register the rate limits with the server.
 *
 * Idempotent — `upsert` is safe to call on every worker boot, which is also the
 * only moment the numbers above can have changed.
 */
export async function ensureRateLimits(): Promise<void> {
  const hatchet = getHatchet();
  for (const { key, limit, duration } of RATE_LIMITS) {
    await hatchet.ratelimits.upsert({ key, limit, duration });
  }
  logger.info(
    `Rate limits registered: ${RATE_LIMITS.map((r) => `${r.key} ${r.limit}/min`).join(', ')}`,
  );
}
