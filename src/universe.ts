/**
 * The reference universe: which stocks it holds, and which of them tonight's
 * run refreshes.
 *
 * Several hundred stocks cannot all be refreshed every night against a
 * 60-per-minute Finnhub budget, and they do not need to be: they are scored to
 * give the score a population, not to be watched. Each night refreshes the
 * `batchSize` members refreshed longest ago, so the whole index comes round
 * every few nights and a symbol a night failed on is still among the oldest.
 *
 * A reference refresh is the data step on a diet (`refreshStockData` with
 * `reference`): no news, no options chain, no Distill, peers once a month, and
 * never an analysis. What it keeps is everything the factor score reads.
 */

import { AppConfig } from './app-config.js';
import { readAppState, writeAppState } from './db/admin.js';
import { referenceRotation } from './db/store.js';
import { fetchSp500 } from './data/universe.js';
import { logger } from './utils/logger.js';

const MEMBERS_KEY = 'universe.members';

/**
 * Fewer members than this and the file is not the index. A truncated download
 * or a renamed column would otherwise shrink the universe to whatever parsed,
 * and the rotation would quietly stop refreshing the rest.
 */
export const MIN_UNIVERSE_SIZE = 400;

interface StoredMembers { fetchedAt: string; members: string[] }

/**
 * The index members, fetched fresh when the list is reachable and the last good
 * list when it is not. Empty only when neither has ever worked.
 */
export async function universeMembers(): Promise<string[]> {
  try {
    const members = await fetchSp500();
    if (members.length >= MIN_UNIVERSE_SIZE) {
      const stored: StoredMembers = { fetchedAt: new Date().toISOString(), members };
      await writeAppState(MEMBERS_KEY, JSON.stringify(stored));
      return members;
    }
    logger.warn(`Universe list parsed to ${members.length} members — keeping the stored list`);
  } catch (e) {
    logger.warn(`Universe list unavailable (${(e as Error).message}) — using the stored list`);
  }
  return storedMembers();
}

/** The last list fetched, without asking for a new one. */
export async function storedMembers(): Promise<string[]> {
  try {
    const raw = await readAppState(MEMBERS_KEY);
    const stored = raw ? JSON.parse(raw) as StoredMembers : null;
    return Array.isArray(stored?.members) ? stored.members : [];
  } catch {
    return [];
  }
}

/**
 * Tonight's reference symbols, least recently refreshed first. Empty when the
 * universe is off, and when the data step is: a reference refresh is that step.
 */
export async function referenceBatch(config: AppConfig): Promise<string[]> {
  const { enabled, batchSize } = config.universe;
  if (!enabled || batchSize <= 0 || !config.steps.data.enabled) return [];
  return referenceRotation(await universeMembers(), batchSize);
}
