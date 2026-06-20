import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';

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

/** Sentinel thrown when the configured API key lacks `briefings:write` scope. */
export class DistillReadOnlyError extends Error {
  constructor(msg = 'Distill key is read-only — mint a write-scoped key to use refresh.') {
    super(msg);
    this.name = 'DistillReadOnlyError';
  }
}

/** The configured token is missing/invalid (401). Distinct from 403 (key
 *  exists but lacks `briefings:write`) so the UI can guide the user to the
 *  right fix (rotate the env var vs. rescope the existing key). */
export class DistillUnauthorizedError extends Error {
  constructor(msg = 'Distill key is missing or invalid — check DISTILL_API_KEY in your .env.') {
    super(msg);
    this.name = 'DistillUnauthorizedError';
  }
}

/** Server returned 422 — the project has multiple briefing types and no
 *  `default_briefing_type_id` set. Fix is admin-side (star a type in the
 *  Distill admin) OR pass `briefingTypeId` explicitly. */
export class DistillAmbiguousTypeError extends Error {
  constructor(msg = 'Distill project has multiple briefing types and no default — star one in the Distill admin (Project → Briefing-Typen) or pass an explicit briefing_type_id.') {
    super(msg);
    this.name = 'DistillAmbiguousTypeError';
  }
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
  briefing:  DistillBriefing | null;
  fetchedAt: string;
  /** Populated only when the bundle was last written by a POST /refresh call.
   *  Lets the UI render cost + cache-state badges without re-querying. */
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

/**
 * Cache-version hash. Bumped to `v2` to invalidate older array-shaped
 * cache files (the schema went from `briefings: []` to `briefing: null`).
 * Includes the limit so any later request-shape change also forces refresh.
 */
export const DISTILL_FETCH_HASH = createHash('md5')
  .update(`distill-v2-single-limit=${DEFAULT_LIMIT}`)
  .digest('hex')
  .slice(0, 8);

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
 * Strip Yahoo exchange suffix conventions to fit Distill's canonical refs:
 *   - US tickers stay bare:           AAPL → ticker:AAPL
 *   - European stay with the venue:   AIR.PA, ENR.DE, MBG.DE → preserved
 *   - Asian numerical with suffix:    7203.T, 0700.HK → preserved
 *
 * Distill's docs explicitly call out the mixed format so we pass the
 * Yahoo-style symbol through unchanged — Distill is the source of truth for
 * what its corpus indexes.
 */
function entityRefFor(symbol: string): string {
  return `ticker:${symbol}`;
}

/**
 * Fetch the most recent briefings for one ticker. Optional / best-effort —
 * a missing key or network error must NOT block the rest of the analysis,
 * so the caller catches and treats absence as "no briefings available".
 */
export async function fetchDistillBriefings(
  symbol: string,
  apiKey: string,
  baseUrl: string,
  briefingTypeId?: string,
  limit: number = DEFAULT_LIMIT,
): Promise<DistillBundle> {
  logger.step(`Fetching Distill briefings for ${symbol}${briefingTypeId ? ` (type ${briefingTypeId.slice(0, 8)}…)` : ''}…`);

  const ref = entityRefFor(symbol);
  let url = `${baseUrl.replace(/\/+$/, '')}/api/v1/briefings`
    + `?entity_ref=${encodeURIComponent(ref)}`
    + `&limit=${limit}`
    + `&offset=0`;
  if (briefingTypeId) {
    url += `&briefing_type_id=${encodeURIComponent(briefingTypeId)}`;
  }

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Distill API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json().catch(() => null) as DistillListResponse | null;
  const data = Array.isArray(json?.data) ? json!.data : [];
  const briefing = data.length > 0 ? normaliseBriefing(data[0]) : null;
  const total = typeof json?.total === 'number' ? json!.total : data.length;

  logger.success(`Distill: ${briefing ? '1 briefing' : 'no briefing'} for ${ref}${total > 1 ? ` (${total} total in DB)` : ''}`);
  return {
    ticker:    symbol,
    baseUrl,
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
 * used server-side (no need to know the UUID on the client).
 *
 * Caveats the caller should handle:
 *  - Long-running: first-time entities with a 100+ raw-insight backlog can
 *    take several minutes (synchronous drain loop). We use a generous 5-min
 *    AbortSignal timeout, but a reverse-proxy in front of Distill may cut it
 *    off sooner.
 *  - 403: the configured DISTILL_API_KEY is read-only. We surface this as a
 *    typed `DistillReadOnlyError` so the UI can disable the button cleanly
 *    instead of bubbling a generic 4xx.
 *  - 200 with empty data: "empty-pool" state — no fresh insights to summarise.
 *    Not an error; the caller surfaces it as a UI hint.
 */
export async function triggerDistillRefresh(
  symbol: string,
  apiKey: string,
  baseUrl: string,
  briefingTypeId?: string,
): Promise<DistillRefreshResult> {
  logger.step(`Distill refresh requested for ${symbol}…`);

  const ref = entityRefFor(symbol);
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/briefings/refresh`;

  // Resolution chain server-side (per Distill API ref): explicit type_id →
  // projects.default_briefing_type_id → single type in project → 422.
  // We only send type_id when the caller has one; otherwise we rely on
  // server-side defaults.
  const body: Record<string, string> = { entity_ref: ref };
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
