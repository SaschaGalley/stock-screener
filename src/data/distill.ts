import { logger } from '../utils/logger.js';
import type { DistillEntityRef } from './distill-entities.js';
import type { DistillDossierContentState } from './distill-dossier.js';
import {
  DistillAmbiguousTypeError,
  DistillEntityGoneError,
  DistillReadOnlyError,
  DistillUnauthorizedError,
} from './distill-errors.js';

// Re-exported so callers keep importing Distill's failure modes from one place.
export {
  DistillAmbiguousTypeError,
  DistillEntityGoneError,
  DistillEntityUnresolvedError,
  DistillReadOnlyError,
  DistillUnauthorizedError,
} from './distill-errors.js';
export type { DistillUnresolvedReason } from './distill-errors.js';
export type { DistillDossierContentState } from './distill-dossier.js';

/**
 * One briefing as returned by Distill's `GET /api/v1/briefings`. We only keep
 * the fields the analyser actually consumes — created_at, body, format, and
 * the briefing-type label are enough to render a section and weight it in the
 * LLM prompt.
 */
export interface DistillBriefing {
  id:                 string;
  briefingTypeId:     string;
  briefingTypeName:   string;
  title:              string;
  body:               string;
  format:             'plain' | 'markdown';
  language:           string;
  entityRefs:         string[];
  insightCount:       number;
  model:              string;
  /** USD cost of the LLM call that produced this briefing. Null for old rows. */
  costUsd:            number | null;
  createdAt:          string;
}

/** Outcome of `POST /api/v1/briefings/refresh` — distinguishes the three states
 *  the server can return so the UI can render a useful badge. */
export type DistillCacheState = 'still-current' | 'generated' | 'empty-pool' | 'unknown';

export interface DistillRefreshResult {
  /** Single currently-relevant briefing returned by POST /refresh, or null
   *  if the project had no fresh insights to summarise ("empty-pool"). */
  briefing:         DistillBriefing | null;
  cacheState:       DistillCacheState;
  /** Summed cost of any distill drain batches the server ran during THIS
   *  request (0 if the briefing was still-current; >0 if drain + generate
   *  ran). The briefing's own LLM cost lives on briefing.costUsd. */
  distillCostUsd:   number;
  refreshedAt:      string;
}

/**
 * One dossier, with enough provenance that the analysis prompt can label it.
 *
 * `kind` is not decoration. A sector dossier read as company-specific is the
 * observed failure mode, not a hypothetical one, so every block says out loud
 * what it is about and the prompt renders that label.
 */
export interface DistillDossierBlock {
  kind:        'company' | 'sector';
  /** `company:apple` / `sector:information_technology` — provenance in one string. */
  ref:         string;
  entityId:    string;
  displayName: string;
  state:       DistillDossierContentState;
  /** Half-open: the last moment covered lies *before* `periodEnd`. */
  periodStart: string | null;
  periodEnd:   string | null;
  builtAt:     string | null;
  stale:       boolean;
  /** Null unless `state` is `ready`. */
  content:     string | null;
}

/**
 * Bundle persisted to the per-symbol cache and consumed by the prompt.
 *
 * Single-briefing model: we only ever show / prompt with ONE briefing per
 * ticker — the currently-relevant one for the pinned `DISTILL_BRIEFING_TYPE_ID`.
 * Distill's GET (with limit=1) and POST /refresh both return exactly that, so
 * there's no need for a list or upsert logic on our side.
 */
export interface DistillBundle {
  ticker:    string;
  baseUrl:   string;
  /**
   * The rolling dossier prose — the company's own, and the sectors it sits in.
   * This is the primary payload: it is free where a briefing costs an LLM call,
   * and it carries a 30-day window rather than a point-in-time summary.
   * Absent in bundles written before the dossier path existed.
   */
  company?:  DistillDossierBlock | null;
  sectors?:  DistillDossierBlock[];
  /** The registry entity this bundle was fetched for — the UUID we called
   *  with, plus how the symbol mapped onto it. Absent only in bundles written
   *  before entity resolution existed, which the server may still serve from
   *  disk via its version-lax read. */
  entity?:   DistillEntityRef | null;
  briefing:  DistillBriefing | null;
  fetchedAt: string;
  /** Populated only when the bundle was last written by a POST /refresh call.
   *  Lets the UI render cost + cache-state badges without re-querying.
   *  With the dossier path this is the exception rather than the rule: the
   *  briefing is now a fallback for what the dossier sweep has not covered. */
  lastRefresh?: {
    cacheState:     DistillCacheState;
    distillCostUsd: number;
    refreshedAt:    string;
  };
}

/** We only need the single currently-relevant briefing per ticker — no
 *  history, no list. limit=1 keeps the response tiny and matches the UI's
 *  single-briefing rendering. */
const DEFAULT_LIMIT = 1;


interface DistillBriefingRow {
  id:                 string;
  project_id?:        string;
  briefing_type_id:   string;
  briefing_type_name: string;
  entity_refs:        string[];
  title:              string;
  body:               string;
  format:             string;
  language:           string;
  insight_count:      number;
  model:              string;
  cost_usd:           number | string | null;
  created_at:         string;
}

interface DistillListResponse {
  data:   DistillBriefingRow[];
  total:  number;
  limit:  number;
  offset: number;
}

/** Numeric coercion for cost_usd — Postgres NUMERIC arrives as string over JSON. */
function toCost(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function normaliseBriefing(b: DistillBriefingRow): DistillBriefing {
  return {
    id:               b.id,
    briefingTypeId:   b.briefing_type_id,
    briefingTypeName: b.briefing_type_name,
    title:            b.title,
    body:             b.body,
    format:           b.format === 'markdown' ? 'markdown' : 'plain',
    language:         b.language,
    entityRefs:       b.entity_refs ?? [],
    insightCount:     b.insight_count ?? 0,
    model:            b.model,
    costUsd:          toCost(b.cost_usd),
    createdAt:        b.created_at,
  };
}

/**
 * Fetch the currently-relevant briefing for one already-resolved entity.
 *
 * `entity_ref` still takes both a UUID and a `type:handle`; we always send the
 * UUID because it is the only identifier that survives a rename. Resolution
 * (and the cache in front of it) lives in `src/distill-service.ts` — this
 * function never guesses a ref from a symbol.
 *
 * Optional / best-effort — a missing key or network error must NOT block the
 * rest of the analysis, so the caller catches and treats absence as "no
 * briefings available".
 */
export async function fetchDistillBriefings(
  symbol: string,
  entity: DistillEntityRef,
  apiKey: string,
  baseUrl: string,
  briefingTypeId?: string,
  limit: number = DEFAULT_LIMIT,
): Promise<DistillBundle> {
  logger.step(`Fetching Distill briefings for ${symbol} (${entity.displayName})${briefingTypeId ? ` (type ${briefingTypeId.slice(0, 8)}…)` : ''}…`);

  let url = `${baseUrl.replace(/\/+$/, '')}/api/v1/briefings`
    + `?entity_ref=${encodeURIComponent(entity.id)}`
    + `&limit=${limit}`
    + `&offset=0`;
  if (briefingTypeId) {
    url += `&briefing_type_id=${encodeURIComponent(briefingTypeId)}`;
  }

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) throw new DistillUnauthorizedError();
  // Defensive: today the list endpoint answers 200-with-empty for an unknown
  // entity_ref (unlike /refresh, which 404s), so the service also re-checks the
  // id when a cached mapping returns no briefing. If that ever tightens to a
  // 404, it lands on the same recovery path instead of a dead end.
  if (res.status === 404) throw new DistillEntityGoneError(entity.id);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Distill API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json().catch(() => null) as DistillListResponse | null;
  const data = Array.isArray(json?.data) ? json!.data : [];
  const briefing = data.length > 0 ? normaliseBriefing(data[0]) : null;
  const total = typeof json?.total === 'number' ? json!.total : data.length;

  logger.success(`Distill: ${briefing ? '1 briefing' : 'no briefing'} for ${entity.displayName} [${entity.id}]${total > 1 ? ` (${total} total in DB)` : ''}`);
  return {
    ticker:    symbol,
    baseUrl,
    entity,
    briefing,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * On-demand refresh — POST `/api/v1/briefings/refresh`. Triggers Distill's
 * substance-based refresh path: drains any pending raw insights through the
 * distillation pipeline, then either returns the still-current briefing or
 * generates a fresh one.
 *
 * Body is `{ entity_ref }` only — the project's default briefing_type_id is
 * used server-side (no need to know the UUID on the client). `entity_ref`
 * accepts a UUID as well as `type:handle`; we send the UUID.
 *
 * Caveats the caller should handle:
 *  - Long-running: first-time entities with a 100+ raw-insight backlog can
 *    take several minutes (synchronous drain loop). We use a generous 5-min
 *    AbortSignal timeout, but a reverse-proxy in front of Distill may cut it
 *    off sooner.
 *  - 403: the configured DISTILL_API_KEY is read-only. We surface this as a
 *    typed `DistillReadOnlyError` so the UI can disable the button cleanly
 *    instead of bubbling a generic 4xx.
 *  - 404: the entity id is gone or the handle went stale. Typed as
 *    `DistillEntityGoneError` — re-resolve, never retry the same id.
 *  - 200 with empty data: "empty-pool" state — no fresh insights to summarise.
 *    Not an error; the caller surfaces it as a UI hint.
 */
export async function triggerDistillRefresh(
  symbol: string,
  entity: DistillEntityRef,
  apiKey: string,
  baseUrl: string,
  briefingTypeId?: string,
): Promise<DistillRefreshResult> {
  logger.step(`Distill refresh requested for ${symbol} (${entity.displayName})…`);

  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/briefings/refresh`;

  // Resolution chain server-side (per Distill API ref): explicit type_id →
  // projects.default_briefing_type_id → single type in project → 422.
  // We only send type_id when the caller has one; otherwise we rely on
  // server-side defaults.
  const body: Record<string, string> = { entity_ref: entity.id };
  if (briefingTypeId) body.briefing_type_id = briefingTypeId;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
    // Generous: drain + LLM can legitimately take minutes on first contact.
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });

  // Status-specific error mapping. Each gets a typed error so callers can
  // render an actionable hint instead of a generic toast.
  if (res.status === 401) throw new DistillUnauthorizedError();
  if (res.status === 403) throw new DistillReadOnlyError();
  if (res.status === 404) throw new DistillEntityGoneError(entity.id);
  if (res.status === 422) throw new DistillAmbiguousTypeError();
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Distill /refresh error ${res.status}: ${text.slice(0, 200)}`);
  }

  const cacheStateHeader = (res.headers.get('x-briefing-cache') ?? '').toLowerCase();
  const cacheState: DistillCacheState =
    cacheStateHeader === 'still-current' || cacheStateHeader === 'generated' || cacheStateHeader === 'empty-pool'
      ? cacheStateHeader
      : 'unknown';
  const distillCostUsd = toCost(res.headers.get('x-distill-cost-usd')) ?? 0;

  // A 2xx refresh may legitimately return an empty/non-JSON body (e.g. 204 or a
  // "still-current" response) — tolerate it instead of throwing away the
  // already-known cacheState/cost.
  const json = await res.json().catch(() => null) as DistillListResponse | null;
  const data = Array.isArray(json?.data) ? json!.data : [];
  const briefing = data.length > 0 ? normaliseBriefing(data[0]) : null;

  logger.success(`Distill refresh: ${cacheState}, ${briefing ? '1 briefing' : 'no briefing'}, distill cost $${distillCostUsd.toFixed(4)}`);
  return {
    briefing,
    cacheState,
    distillCostUsd,
    refreshedAt: new Date().toISOString(),
  };
}
