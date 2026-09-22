/**
 * Cached access to the Finnhub peer-group medians.
 *
 * Lives above the data layer for the same reason the Distill orchestration
 * does: `data/finnhub.ts` stays pure HTTP, `db/store.ts` stays pure
 * persistence, and the policy that joins them sits here.
 *
 * The policy is small but load-bearing. One call costs nine Finnhub requests
 * against a 60/min free tier, and it used to run on every stock the web UI
 * opened — so a handful of clicks in a minute was enough to hit the limit and
 * turn a fast page into a slow one. Everything reads through here now.
 */

import { SectorMedians } from './types.js';
import { logger } from './utils/logger.js';
import { readSectorMedians, snapshotHistory, writeSectorMedians } from './db/store.js';
import { getSectorMedians } from './data/finnhub.js';

/**
 * Whether a stored peer-median payload is one.
 *
 * Until 22 September a rate-limited fetch — every peer request refused — was
 * stored as a group of zero peers with every median null, and the history
 * holds dozens of them (10 of 31 fetches on 16 August). They are not a reading
 * of the industry, so every reader skips them.
 */
export function hasPeers(m: SectorMedians | null | undefined): m is SectorMedians {
  return !!m && (m.peerCount ?? 0) > 0;
}

/** The newest stored medians that actually came from peers, however old. */
export async function lastGoodSectorMedians(symbol: string): Promise<SectorMedians | null> {
  const history = await snapshotHistory<SectorMedians>(symbol, 'sector_medians');
  for (let i = history.length - 1; i >= 0; i--) {
    if (hasPeers(history[i].data)) return history[i].data;
  }
  return null;
}

/** Coalesces concurrent requests for the same symbol into one upstream call. */
const inFlight = new Map<string, Promise<SectorMedians | null>>();

/**
 * Peer medians for a symbol, from cache when fresh.
 *
 * Returns null instead of throwing — every caller treats peer data as optional
 * enrichment. A failed fetch is deliberately not cached: peers missing for a
 * day because Finnhub hiccuped once would be a worse outcome than retrying.
 * Meanwhile the last good medians stand in, however old: peer groups change
 * slowly, and scoring a day without them drops the peer-multiples model and
 * the peer margin from the valuation — a jump in the series that says nothing
 * about the company.
 */
export async function getSectorMediansCached(
  symbol: string,
  apiKey: string | undefined,
): Promise<SectorMedians | null> {
  if (!apiKey) return null;

  const stored = await readSectorMedians(symbol);
  if (hasPeers(stored)) return stored;

  const pending = inFlight.get(symbol);
  if (pending) return pending;

  const request = (async () => {
    try {
      const medians = await getSectorMedians(symbol, apiKey);
      if (medians) {
        await writeSectorMedians(symbol, medians);
        return medians;
      }
      return await lastGoodSectorMedians(symbol);
    } catch (e) {
      logger.debug(`Sector medians unavailable for ${symbol}: ${(e as Error).message}`);
      return await lastGoodSectorMedians(symbol).catch(() => null);
    } finally {
      inFlight.delete(symbol);
    }
  })();

  inFlight.set(symbol, request);
  return request;
}
