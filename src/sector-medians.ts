/**
 * Cached access to the Finnhub peer-group medians.
 *
 * Lives above the data layer for the same reason the Distill orchestration
 * does: `data/finnhub.ts` stays pure HTTP, `cache.ts` stays pure filesystem,
 * and the policy that joins them sits here.
 *
 * The policy is small but load-bearing. One call costs nine Finnhub requests
 * against a 60/min free tier, and it used to run on every stock the web UI
 * opened — so a handful of clicks in a minute was enough to hit the limit and
 * turn a fast page into a slow one. Everything reads through here now.
 */

import { SectorMedians } from './types.js';
import { logger } from './utils/logger.js';
import { readSectorMedians, writeSectorMedians } from './cache.js';
import { getSectorMedians } from './data/finnhub.js';

/** Coalesces concurrent requests for the same symbol into one upstream call. */
const inFlight = new Map<string, Promise<SectorMedians | null>>();

/**
 * Peer medians for a symbol, from cache when fresh.
 *
 * Returns null instead of throwing — every caller treats peer data as optional
 * enrichment. A failed fetch is deliberately not cached: peers missing for a
 * day because Finnhub hiccuped once would be a worse outcome than retrying.
 */
export async function getSectorMediansCached(
  cacheDir: string,
  symbol: string,
  apiKey: string | undefined,
): Promise<SectorMedians | null> {
  if (!apiKey) return null;

  const cached = readSectorMedians(cacheDir, symbol);
  if (cached) return cached;

  const pending = inFlight.get(symbol);
  if (pending) return pending;

  const request = (async () => {
    try {
      const medians = await getSectorMedians(symbol, apiKey);
      if (medians) writeSectorMedians(cacheDir, symbol, medians);
      return medians;
    } catch (e) {
      logger.debug(`Sector medians unavailable for ${symbol}: ${(e as Error).message}`);
      return null;
    } finally {
      inFlight.delete(symbol);
    }
  })();

  inFlight.set(symbol, request);
  return request;
}
