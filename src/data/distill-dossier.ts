/**
 * The dossier switch — `GET`/`PUT /api/v1/entities/{id}/dossier`.
 *
 * Distill builds dossiers only for entities whose switch is on, and each one
 * costs money per day. So the switch is not a setting somebody flips once: it
 * has to follow our watchlist. This module is the transport for that — pure
 * HTTP plus the status classification the caller acts on. The mirroring itself
 * lives one layer up in `src/distill-dossiers.ts`, and the ledger it keeps in
 * `db/admin.ts`; nothing here has state.
 *
 * The switch is idempotent in both directions — enabling twice is enabling
 * once, disabling what is already off is not an error — which is what lets the
 * sync re-send the whole watchlist rather than track what it already sent.
 *
 * Turning it off deletes nothing upstream: existing dossiers stand, they just
 * stop being extended. A stock that comes back still has its history.
 */

import { logger } from '../utils/logger.js';
import {
  DistillDossierIneligibleError,
  DistillDossierScopeError,
  DistillEntityGoneError,
  DistillUnauthorizedError,
} from './distill-errors.js';

/** The switch as Distill reports it. */
export interface DistillDossierState {
  ref:     string;
  id:      string;
  enabled: boolean;
  /**
   * Whether this entity may host a dossier at all. Only `GET` reports it —
   * `PUT` answers with the switch alone — hence nullable.
   */
  eligible: boolean | null;
}

/**
 * Backoff between attempts, and therefore also the number of them.
 *
 * A parameter rather than a constant so the tests can drive the retry path
 * without sleeping through it. Only transport faults (5xx, network) are
 * retried; every 4xx is an answer, not a fault, and is classified immediately.
 */
export const DOSSIER_RETRY_DELAYS_MS: readonly number[] = [500, 2_000, 5_000];

export interface DossierRequestOptions {
  retryDelaysMs?: readonly number[];
  timeoutMs?:     number;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function dossierUrl(entityId: string, baseUrl: string): string {
  return `${trimBase(baseUrl)}/api/v1/entities/${encodeURIComponent(entityId)}/dossier`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Issue the request, retrying only what is worth retrying.
 *
 * A 5xx or a dropped connection is the one failure mode where the same call can
 * succeed unchanged, and the switch being idempotent means a retry cannot
 * double-apply anything. Everything else comes back for `classify` to turn into
 * a typed error the caller can act on differently.
 */
async function request(
  url: string,
  init: RequestInit,
  label: string,
  opts: DossierRequestOptions,
): Promise<Response> {
  const delays = opts.retryDelaysMs ?? DOSSIER_RETRY_DELAYS_MS;
  let last: Error = new Error(`Distill ${label} failed`);

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      logger.debug(`Distill ${label}: retry ${attempt}/${delays.length} after ${delays[attempt - 1]}ms — ${last.message}`);
      await sleep(delays[attempt - 1]);
    }
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (res.status < 500) return res;
      const text = await res.text().catch(() => '');
      last = new Error(`Distill ${label} error ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      last = e as Error;
    }
  }
  throw last;
}

/**
 * Turn a non-OK response into the error that says what to do about it. The four
 * cases are genuinely different actions, which is why they are four classes and
 * not one message:
 *
 *   401 → the token is missing or wrong          → fix the env var
 *   403 → the key has no `dossiers:write`        → re-issue the key, stop trying
 *   404 → the entity id is stale                 → re-resolve, then retry once
 *   409 → the type may not host a dossier        → standing condition, record it
 */
async function classify(res: Response, entityId: string, label: string): Promise<never> {
  const text = await res.text().catch(() => '');
  const detail = text.slice(0, 200);

  if (res.status === 401) throw new DistillUnauthorizedError();
  if (res.status === 403) throw new DistillDossierScopeError();
  if (res.status === 404) throw new DistillEntityGoneError(entityId);
  if (res.status === 409) {
    throw new DistillDossierIneligibleError(
      entityId,
      detail
        ? `Distill will not host a dossier on entity ${entityId}: ${detail}`
        : undefined,
    );
  }
  throw new Error(`Distill ${label} error ${res.status}: ${detail}`);
}

function toState(json: unknown, fallbackId: string, fallbackEnabled: boolean): DistillDossierState {
  const row = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  return {
    ref:      typeof row.ref === 'string' ? row.ref : '',
    id:       typeof row.id === 'string' ? row.id : fallbackId,
    enabled:  typeof row.enabled === 'boolean' ? row.enabled : fallbackEnabled,
    eligible: typeof row.eligible === 'boolean' ? row.eligible : null,
  };
}

/**
 * Read the switch. Needs no write scope, so this is also the safe way to check
 * a key before a sync writes anything.
 */
export async function getDistillDossier(
  entityId: string,
  apiKey: string,
  baseUrl: string,
  opts: DossierRequestOptions = {},
): Promise<DistillDossierState> {
  const res = await request(
    dossierUrl(entityId, baseUrl),
    { headers: { 'Authorization': `Bearer ${apiKey}` } },
    'dossier read',
    opts,
  );
  if (!res.ok) await classify(res, entityId, 'dossier read');
  return toState(await res.json().catch(() => null), entityId, false);
}

/** Set the switch. Idempotent in both directions. */
export async function setDistillDossier(
  entityId: string,
  enabled: boolean,
  apiKey: string,
  baseUrl: string,
  opts: DossierRequestOptions = {},
): Promise<DistillDossierState> {
  const res = await request(
    dossierUrl(entityId, baseUrl),
    {
      method:  'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ enabled }),
    },
    'dossier write',
    opts,
  );
  if (!res.ok) await classify(res, entityId, 'dossier write');
  return toState(await res.json().catch(() => null), entityId, enabled);
}
