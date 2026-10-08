/**
 * Where the depot check keeps its progress and its result: `app_state`, under
 * the trades source, so a placeholder's check in development never overwrites
 * the real one. Apart from the check itself because the depot view reads the
 * last result's stops, and the check reads the depot view.
 */

import type { DepotCheckResult, DepotCheckStatus } from './analysis/depot-check.js';
import { readAppState } from './db/admin.js';
import { tradesSource } from './trades-service.js';

export const CHECK_STATUS_KEY = () => `depot.check.${tradesSource()}.status`;
export const CHECK_RESULT_KEY = () => `depot.check.${tradesSource()}.result`;

export async function readStateJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await readAppState(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

export const readCheckStatus = () => readStateJson<DepotCheckStatus>(CHECK_STATUS_KEY());
export const readCheckResult = () => readStateJson<DepotCheckResult>(CHECK_RESULT_KEY());
