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

export interface DossierContentOptions extends DossierRequestOptions {
  /** Ask for the insights the dossier does not reproduce. */
  includeInsights?: boolean;
  /** 1…200 upstream, default 25 there. */
  insightLimit?:    number;
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
 *   ready       the prose is there, at most a day behind its window
 *   outdated    the prose is there but lags further: Distill's nightly sweep
 *               missed a night or is switched off. Still true for its own
 *               window, no longer the current state — `behindDays` says how far
 *   not_enabled the switch is off. Deliberately *no* content: switching off
 *               deletes nothing, so an artefact whose window stopped weeks ago
 *               is still lying there and would read as the current state
 *   not_built   switched on, but the nightly sweep has not reached it yet
 *   empty       built, and nothing happened in the window. Not a failure
 *
 * `outdated` exists because a bare `stale` flag was not enough: from 16 to 27
 * September 2026 the sweep did not run, every dossier came back `ready` and
 * twelve days old, and this client read the flag as "a late document, the
 * window still holds" (distill#168).
 */
export type DistillDossierContentState = 'ready' | 'outdated' | 'not_enabled' | 'not_built' | 'empty';

const CONTENT_STATES: readonly string[] = ['ready', 'outdated', 'not_enabled', 'not_built', 'empty'];

/**
 * Why Distill considers a dossier stale — one value per stale rule, in rule
 * order. Only `late_material` is harmless: a document that arrived late and
 * carries a date inside a day that was already built.
 */
export type DistillStaleReason = 'late_material' | 'child_stale' | 'window_moved' | 'material_withdrawn';

const STALE_REASONS: readonly DistillStaleReason[] =
  ['late_material', 'child_stale', 'window_moved', 'material_withdrawn'];

export interface DistillDossierBody {
  unit:        string;
  span:        number | null;
  /** Half-open: the last moment covered lies *before* `periodEnd`. */
  periodStart: string | null;
  periodEnd:   string | null;
  builtAt:     string | null;
  /** Short for "`staleReasons` is not empty". Branch on the reasons instead. */
  stale:       boolean;
  /** Empty for a valid dossier. Unknown values from a newer Distill are dropped,
   *  so `stale` can be true while this is empty. */
  staleReasons: DistillStaleReason[];
  /** Calendar days (Europe/Vienna) between `periodEnd` and the end of today's
   *  window. 0 is freshly built, 1 is normal until the night's sweep has run.
   *  Null when Distill did not say (older versions). */
  behindDays:  number | null;
  chars:       number | null;
  content:     string;
}

/**
 * One raw insight — an extracted statement, not a synthesis.
 *
 * `at` is the *period axis* Distill cuts dossiers on, which is the news date,
 * not the moment Distill saw it. A document that came in today carrying
 * yesterday's date is stamped yesterday here — that is deliberate, and it is
 * what makes these comparable with a dossier's window.
 */
export interface DistillInsight {
  id:            string;
  at:            string | null;
  content:       string;
  documentTitle: string | null;
  documentUrl:   string | null;
  sourceName:    string | null;
}

/**
 * What the dossier does not (yet) reproduce.
 *
 * The membership rule is Distill's and is about *provenance*, not dates: an
 * insight is excluded when the artefact actually reproduces it through one of
 * its edges. That is why `from` is the period **start** and not the end — a
 * late-arriving document whose axis falls inside the window but whose text
 * never made it into the dossier is exactly the class that makes a dossier
 * `stale`, and a cut at the window's end would drop it from both sides.
 *
 * So: do not filter this list. `from`/`to` are here to tell the model which
 * span it is looking at, not to derive a boundary from.
 */
export interface DistillInsightWindow {
  from:      string | null;
  to:        string | null;
  /** Length of `items`, NOT how many exist. Only `truncated` says there are more. */
  count:     number;
  /** `insight_limit` bit. Counts only — Distill applies no character cap. */
  truncated: boolean;
  /**
   * What `insight_limit` cut: how many, and the span of their dates. The oldest
   * go first, so the gap sits before the first item — usually right behind the
   * dossier's window. Null when nothing was cut or Distill did not say;
   * absent in bundles stored before Distill reported it.
   */
  omitted?:  { count: number; from: string | null; to: string | null } | null;
  /** Cut newest-first upstream, then handed back in chronological order. */
  items:     DistillInsight[];
}

/**
 * Whether Distill builds dossiers at all. `enabled` is its switch — which only
 * takes effect when its workers next start — and the last finished run says
 * whether anything actually happened. Neither alone answers "will tonight's
 * build fill this?".
 */
export interface DistillSweepStatus {
  enabled:            boolean;
  lastRunFinishedAt:  string | null;
  lastRunStatus:      string | null;
}

export interface DistillDossierContent {
  ref:      string;
  /** The merge root, which may differ from the ref that was asked for. */
  id:       string;
  enabled:  boolean;
  eligible: boolean | null;
  state:    DistillDossierContentState;
  dossier:  DistillDossierBody | null;
  /** Only present when asked for with `includeInsights`. */
  insights: DistillInsightWindow | null;
  /** Null when Distill did not say (older versions). */
  sweep:    DistillSweepStatus | null;
}

function toSweep(raw: unknown): DistillSweepStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.enabled !== 'boolean') return null;
  return {
    enabled:           s.enabled,
    lastRunFinishedAt: typeof s.last_run_finished_at === 'string' ? s.last_run_finished_at : null,
    lastRunStatus:     typeof s.last_run_status === 'string' ? s.last_run_status : null,
  };
}

function toOmitted(raw: unknown): DistillInsightWindow['omitted'] {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.count !== 'number' || o.count <= 0) return null;
  return {
    count: o.count,
    from:  typeof o.from === 'string' ? o.from : null,
    to:    typeof o.to === 'string' ? o.to : null,
  };
}

function toInsight(raw: unknown): DistillInsight | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const content = typeof r.content === 'string' ? r.content.trim() : '';
  if (!content) return null;
  return {
    id:            typeof r.id === 'string' ? r.id : '',
    at:            typeof r.at === 'string' ? r.at : null,
    content,
    documentTitle: typeof r.document_title === 'string' ? r.document_title : null,
    documentUrl:   typeof r.document_url === 'string' ? r.document_url : null,
    sourceName:    typeof r.source_name === 'string' ? r.source_name : null,
  };
}

function toInsights(raw: unknown): DistillInsightWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const items = (Array.isArray(w.data) ? w.data : [])
    .map(toInsight)
    .filter((i): i is DistillInsight => i !== null);
  return {
    from:      typeof w.from === 'string' ? w.from : null,
    to:        typeof w.to === 'string' ? w.to : null,
    // Reported by Distill as the length of `data`; recomputed from what we
    // actually parsed so a dropped empty row cannot make the two disagree.
    count:     items.length,
    truncated: w.truncated === true,
    omitted:   toOmitted(w.omitted),
    items,
  };
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
    staleReasons: (Array.isArray(d.stale_reasons) ? d.stale_reasons : [])
      .filter((r): r is DistillStaleReason => STALE_REASONS.includes(r as DistillStaleReason)),
    behindDays:  typeof d.behind_days === 'number' ? d.behind_days : null,
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
  opts: DossierContentOptions = {},
): Promise<DistillDossierContent> {
  let url = `${trimBase(baseUrl)}/api/v1/entities/${encodeURIComponent(ref)}/dossier/content`;
  if (opts.includeInsights) {
    url += '?include=insights';
    if (opts.insightLimit) {
      url += `&insight_limit=${Math.min(200, Math.max(1, Math.trunc(opts.insightLimit)))}`;
    }
  }
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
    // Only `ready` and `outdated` carry prose. A `not_enabled` answer can still
    // ship a stale artefact, and taking it would mean reading a window that
    // stopped moving weeks ago as though it were current. `outdated` prose is
    // taken because Distill says so itself — with how far it lags, which the
    // prompt passes on.
    dossier:  state === 'ready' || state === 'outdated' ? toBody(row.dossier) : null,
    // Insights, by contrast, are valid in every state — for anything but
    // `ready` they *are* the material, covering the same 30 days the paid
    // briefing used to read.
    insights: toInsights(row.insights),
    sweep:    toSweep(row.sweep),
  };
}
