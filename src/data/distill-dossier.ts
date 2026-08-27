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

// ── Dossier content ──────────────────────────────────────────────────────────

/**
 * Where a dossier stands. Distill answers 200 with this rather than a status
 * code for everything except an entity it does not know, so this field — not
 * the HTTP status — is what the caller branches on.
 *
 *   ready       the prose is there
 *   not_enabled the switch is off. Deliberately *no* content: switching off
 *               deletes nothing, so an artefact whose window stopped weeks ago
 *               is still lying there and would read as the current state
 *   not_built   switched on, but the nightly sweep has not reached it yet
 *   empty       built, and nothing happened in the window. Not a failure
 */
export type DistillDossierContentState = 'ready' | 'not_enabled' | 'not_built' | 'empty';

const CONTENT_STATES: readonly string[] = ['ready', 'not_enabled', 'not_built', 'empty'];

export interface DistillDossierBody {
  unit:        string;
  span:        number | null;
  /** Half-open: the last moment covered lies *before* `periodEnd`. */
  periodStart: string | null;
  periodEnd:   string | null;
  builtAt:     string | null;
  /** Common and usually harmless — a late document landing in a built tile.
   *  Carry it, do not branch on it: the window is still the truth. */
  stale:       boolean;
  chars:       number | null;
  content:     string;
}

export interface DistillDossierContent {
  ref:      string;
  /** The merge root, which may differ from the ref that was asked for. */
  id:       string;
  enabled:  boolean;
  eligible: boolean | null;
  state:    DistillDossierContentState;
  dossier:  DistillDossierBody | null;
}

function toBody(raw: unknown): DistillDossierBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const content = typeof d.content === 'string' ? d.content : '';
  if (!content.trim()) return null;
  return {
    unit:        typeof d.unit === 'string' ? d.unit : 'day',
    span:        typeof d.span === 'number' ? d.span : null,
    periodStart: typeof d.period_start === 'string' ? d.period_start : null,
    periodEnd:   typeof d.period_end === 'string' ? d.period_end : null,
    builtAt:     typeof d.built_at === 'string' ? d.built_at : null,
    stale:       d.stale === true,
    chars:       typeof d.chars === 'number' ? d.chars : content.length,
    content,
  };
}

/**
 * `GET /api/v1/entities/{ref}/dossier/content` — the rolling dossier prose.
 *
 * The reason this path exists at all: it is free, where `POST /briefings/refresh`
 * spends an LLM call per symbol per night, and it carries a 30-day window rather
 * than a point-in-time summary. What it cannot carry is *today* — the window
 * closes at the start of the current day by construction, so a caller that needs
 * intraday freshness still has to take the briefing path.
 *
 * `ref` may be a UUID or `type:handle`; both resolve to the same merge root.
 * 404 here means one thing only — an entity Distill does not know.
 */
export async function getDistillDossierContent(
  ref: string,
  apiKey: string,
  baseUrl: string,
  opts: DossierRequestOptions = {},
): Promise<DistillDossierContent> {
  const url = `${trimBase(baseUrl)}/api/v1/entities/${encodeURIComponent(ref)}/dossier/content`;
  const res = await request(
    url,
    { headers: { 'Authorization': `Bearer ${apiKey}` } },
    'dossier content',
    opts,
  );
  if (!res.ok) await classify(res, ref, 'dossier content');

  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
  const row = (json ?? {}) as Record<string, unknown>;
  const state = typeof row.state === 'string' && CONTENT_STATES.includes(row.state)
    ? row.state as DistillDossierContentState
    : 'not_built';

  return {
    ref:      typeof row.ref === 'string' ? row.ref : ref,
    id:       typeof row.id === 'string' ? row.id : ref,
    enabled:  row.enabled === true,
    eligible: typeof row.eligible === 'boolean' ? row.eligible : null,
    state,
    // Only `ready` may carry prose. A `not_enabled` answer can still ship a
    // stale artefact, and taking it would mean reading a window that stopped
    // moving weeks ago as though it were current.
    dossier:  state === 'ready' ? toBody(row.dossier) : null,
  };
}
