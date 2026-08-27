/**
 * Distill entity registry client — turns the identifiers we hold (ISIN, Yahoo
 * symbol, company name) into the opaque entity UUID the briefings API expects.
 *
 * Background: Distill's registry moved from guessable refs (`ticker:MSFT`) to
 * opaque UUIDs with typed handles (`company:microsoft`). A ticker is now just
 * one of several *keys* an entity is findable under, alongside ISIN, FIGI, LEI,
 * exchange symbols and aliases. `ticker:` as a prefix is dead: an unknown
 * prefix returns zero hits by design rather than being reinterpreted as free
 * text (otherwise `company:apple` and `ticker:apple` would be indistinguishable).
 *
 * The UUID is the only stable identifier — handles change on rename, tickers
 * are not globally unique, names least of all. So we cache the id, never a ref
 * string (see `readDistillEntity`/`writeDistillEntity` in `cache.ts`).
 *
 * This module is deliberately free of cache/filesystem imports: it is pure
 * HTTP + match policy. The cached resolution loop lives in
 * `src/distill-service.ts`, one layer up.
 */

import { logger } from '../utils/logger.js';
import { DistillUnauthorizedError } from './distill-errors.js';

/**
 * How a hit was found. The search is *tiered*, not relevance-weighted, so the
 * tier is a trust level: it says how confidently we may take a hit without a
 * human looking at it. Results come back sorted by tier, best first.
 */
export type DistillMatchTier = 'id' | 'ref' | 'key' | 'symbol' | 'alias' | 'name';

/** Sort weight per tier — used to defensively re-sort the response. */
const TIER_ORDER: Record<DistillMatchTier, number> = {
  id: 0, ref: 1, key: 2, symbol: 3, alias: 4, name: 5,
};

function isTier(v: unknown): v is DistillMatchTier {
  return typeof v === 'string' && v in TIER_ORDER;
}

/** One row from `GET /api/v1/entities/search`. */
export interface DistillEntityHit {
  id:            string;
  ref:           string;
  type:          string;
  handle:        string;
  displayName:   string;
  matchedOn:     DistillMatchTier;
  matchedValue:  string;
  primarySymbol: string | null;
  country:       string | null;
  sector:        string | null;
  isin:          string | null;
}

/**
 * What we persist per symbol: the UUID plus enough provenance to explain (and
 * audit) the mapping later. `baseUrl` is part of the record because entity ids
 * are per-installation — pointing DISTILL_API_URL at another deployment must
 * not reuse ids resolved against the old one.
 */
export interface DistillEntityRef {
  /** Opaque UUID — the only stable identifier. This is what we send. */
  id:           string;
  /** `type:handle`, e.g. `company:microsoft`. Informational: handles change. */
  ref:          string;
  type:         string;
  displayName:  string;
  /** Trust tier the mapping came from, and the value that matched. */
  matchedOn:    DistillMatchTier;
  matchedValue: string;
  /** The identifier we searched with — useful when a mapping looks wrong. */
  query:        string;
  baseUrl:      string;
  resolvedAt:   string;
}

/** Full record from `GET /api/v1/entities/{ref}` — we only keep what we act on. */
export interface DistillEntityDetail {
  id:          string;
  ref:         string;
  type:        string;
  handle:      string;
  displayName: string;
  /** `active` | `quarantined` | `rejected` — search only ever returns active. */
  status:      string | null;
}

/** Identifiers we can search with, best-first per Distill's recommendation. */
export interface DistillEntityHints {
  symbol:       string;
  isin?:        string | null;
  companyName?: string | null;
}

interface EntitySearchRow {
  id?:             string;
  ref?:            string;
  type?:           string;
  handle?:         string;
  display_name?:   string;
  matched_on?:     string;
  matched_value?:  string;
  primary_symbol?: string | null;
  country?:        string | null;
  sector?:         string | null;
  isin?:           string | null;
  status?:         string | null;
}

interface EntitySearchResponse {
  data?:  EntitySearchRow[];
  total?: number;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Normalise an identifier before searching.
 *
 * The `ticker:` prefix is stripped rather than sent: Distill returns zero hits
 * for unknown prefixes on purpose, so any leftover `ticker:MSFT` — in old code
 * paths, an old cache file, or hand-typed input — is migrated here by cutting
 * the prefix and searching the bare `MSFT`. Case and whitespace are irrelevant
 * to the API, so we only trim.
 */
export function normaliseEntityQuery(raw: string): string {
  return raw.trim().replace(/^ticker:/i, '').trim();
}

function toHit(row: EntitySearchRow): DistillEntityHit | null {
  if (!row?.id || typeof row.id !== 'string') return null;
  return {
    id:            row.id,
    ref:           row.ref ?? '',
    type:          row.type ?? '',
    handle:        row.handle ?? '',
    displayName:   row.display_name ?? row.ref ?? row.id,
    matchedOn:     isTier(row.matched_on) ? row.matched_on : 'name',
    matchedValue:  row.matched_value ?? '',
    primarySymbol: row.primary_symbol ?? null,
    country:       row.country ?? null,
    sector:        row.sector ?? null,
    isin:          row.isin ?? null,
  };
}

/**
 * `GET /api/v1/entities/search`. Read-only key is enough — no extra scope.
 * `q` takes any identifier: UUID, `type:handle`, ISIN, FIGI, LEI, ticker,
 * CoinGecko id, index/exchange symbol, alias, or a name fragment.
 */
export async function searchDistillEntities(
  q: string,
  apiKey: string,
  baseUrl: string,
  opts: { type?: string; limit?: number } = {},
): Promise<{ hits: DistillEntityHit[]; total: number }> {
  const query = normaliseEntityQuery(q);
  if (!query) return { hits: [], total: 0 };

  const limit = Math.min(50, Math.max(1, Math.trunc(opts.limit ?? 10)));
  let url = `${trimBase(baseUrl)}/api/v1/entities/search`
    + `?q=${encodeURIComponent(query)}`
    + `&limit=${limit}`;
  if (opts.type) url += `&type=${encodeURIComponent(opts.type)}`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) throw new DistillUnauthorizedError();
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Distill entity search error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json().catch(() => null) as EntitySearchResponse | null;
  const rows = Array.isArray(json?.data) ? json!.data! : [];
  const hits = rows
    .map(toHit)
    .filter((h): h is DistillEntityHit => h !== null)
    // The API already sorts by tier; re-sorting keeps `hits[0]` the best hit
    // even if that ever changes. Array#sort is stable, so ties keep API order.
    .sort((a, b) => TIER_ORDER[a.matchedOn] - TIER_ORDER[b.matchedOn]);
  const total = typeof json?.total === 'number' ? json!.total! : hits.length;

  return { hits, total };
}

/**
 * `GET /api/v1/entities/{ref}` where `{ref}` is a UUID or `type:handle`.
 * Returns null on 404 (unknown entity).
 *
 * Two things set this apart from search, and we rely on both:
 *  1. It resolves to the *merge root* — a cached id stays valid after the
 *     entity is merged into another; if `id` differs from what we asked for,
 *     the cached id must be replaced.
 *  2. It reports every status. Search only ever emits `active`, so a cached id
 *     that suddenly serves no briefings is explained here (`quarantined` /
 *     `rejected`).
 */
export async function getDistillEntity(
  ref: string,
  apiKey: string,
  baseUrl: string,
): Promise<DistillEntityDetail | null> {
  const url = `${trimBase(baseUrl)}/api/v1/entities/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) return null;
  if (res.status === 401) throw new DistillUnauthorizedError();
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Distill entity lookup error ${res.status}: ${text.slice(0, 200)}`);
  }

  // Tolerate both envelope shapes: `{ data: {...} }` like the list endpoints,
  // or the bare record.
  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!json) return null;
  const row = (typeof json.data === 'object' && json.data !== null ? json.data : json) as EntitySearchRow;
  if (!row.id || typeof row.id !== 'string') return null;

  return {
    id:          row.id,
    ref:         row.ref ?? '',
    type:        row.type ?? '',
    handle:      row.handle ?? '',
    displayName: row.display_name ?? row.ref ?? row.id,
    status:      row.status ?? null,
  };
}

/** ISIN / FIGI / LEI are globally unique, so a `key` hit on one is unambiguous
 *  even when the search returns other rows. A ticker key is not. */
function isUniqueKeyMatch(matchedValue: string): boolean {
  return /^(isin|figi|lei)\s*:/i.test(matchedValue.trim());
}

/**
 * Per-tier auto-accept policy, straight from Distill's handover table:
 *
 *   id / ref     → yes
 *   key          → yes for ISIN/FIGI/LEI; a ticker key only when unambiguous
 *   symbol/alias → only when `total === 1`
 *   name         → never blindly; a human picks
 */
export function acceptsAutomatically(hit: DistillEntityHit, total: number): boolean {
  switch (hit.matchedOn) {
    case 'id':
    case 'ref':    return true;
    case 'key':    return isUniqueKeyMatch(hit.matchedValue) || total === 1;
    case 'symbol':
    case 'alias':  return total === 1;
    case 'name':   return false;
  }
}

export type DistillEntityResolution =
  | { status: 'resolved';  entity: DistillEntityRef }
  | { status: 'ambiguous'; query: string; candidates: DistillEntityHit[] }
  | { status: 'not-found'; queries: string[] };

function toRef(hit: DistillEntityHit, query: string, baseUrl: string): DistillEntityRef {
  return {
    id:           hit.id,
    ref:          hit.ref,
    type:         hit.type,
    displayName:  hit.displayName,
    matchedOn:    hit.matchedOn,
    matchedValue: hit.matchedValue,
    query,
    baseUrl,
    resolvedAt:   new Date().toISOString(),
  };
}

/**
 * Build the query chain. Distill's recommended order when several identifiers
 * are on hand is ISIN → ticker → name: the ISIN is the only one guaranteed
 * unique, so it goes first and a single hit ends the search.
 *
 * The Yahoo symbol is passed through unchanged, exchange suffix included
 * (`AIR.PA`, `7203.T`, `0700.HK`) — Distill indexes exchange symbols. We do
 * NOT fall back to the bare root (`AIR`): that root frequently belongs to a
 * different company on another exchange, which is exactly the guess the tiered
 * search exists to prevent.
 */
function buildQueryChain(hints: DistillEntityHints): string[] {
  const raw = [hints.isin, hints.symbol, hints.companyName];
  const out: string[] = [];
  for (const candidate of raw) {
    if (!candidate) continue;
    const q = normaliseEntityQuery(candidate);
    if (!q) continue;
    if (out.some((seen) => seen.toLowerCase() === q.toLowerCase())) continue;
    out.push(q);
  }
  return out;
}

/**
 * Resolve our identifiers to an entity UUID. Stops at the first hit the tier
 * policy lets us take unattended; otherwise reports the best ambiguous set so
 * the caller can put it in front of a human instead of guessing.
 */
export async function resolveDistillEntity(
  hints: DistillEntityHints,
  apiKey: string,
  baseUrl: string,
): Promise<DistillEntityResolution> {
  const queries = buildQueryChain(hints);
  let ambiguous: { query: string; candidates: DistillEntityHit[] } | null = null;

  for (const query of queries) {
    const { hits, total } = await searchDistillEntities(query, apiKey, baseUrl);
    if (hits.length === 0) continue;

    const top = hits[0];
    if (acceptsAutomatically(top, total)) {
      logger.debug(
        `Distill entity: ${hints.symbol} → ${top.id} (${top.displayName}) `
        + `via ${top.matchedOn}="${query}"${total > 1 ? ` of ${total} hits` : ''}`,
      );
      return { status: 'resolved', entity: toRef(top, query, baseUrl) };
    }

    // Keep the first non-acceptable hit set — it came from the most trusted
    // identifier we have, so it is the most useful thing to show a human.
    if (!ambiguous) ambiguous = { query, candidates: hits.slice(0, 5) };
  }

  if (ambiguous) return { status: 'ambiguous', ...ambiguous };
  return { status: 'not-found', queries };
}

/**
 * One entry of `GET /api/v1/entity-types` — the project's entity-type catalogue.
 * We read one thing from it, the sector vocabulary, but the shape is the type's.
 */
export interface DistillEntityType {
  type:            string;
  validationMode:  string | null;
  dossierEligible: boolean | null;
  /** `handle → display name`, and for a `fixed_list` type this *is* the vocabulary. */
  canonicalValues: Record<string, string>;
}

/**
 * `GET /api/v1/entity-types`. Read-only, no scope needed.
 *
 * Fetched rather than hardcoded because the sector list is a project setting:
 * a thirteenth sector should surface on the next sync, not on the next deploy.
 * The endpoint answers with a bare array, not the `{data}` envelope the entity
 * endpoints use, so both are tolerated.
 */
export async function getDistillEntityTypes(
  apiKey: string,
  baseUrl: string,
): Promise<DistillEntityType[]> {
  const res = await fetch(`${trimBase(baseUrl)}/api/v1/entity-types`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) throw new DistillUnauthorizedError();
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Distill entity-types error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json().catch(() => null);
  const rows: unknown[] = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown[] } | null)?.data)
      ? (json as { data: unknown[] }).data
      : [];

  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    if (typeof row.type !== 'string') return [];
    const values = row.canonical_values;
    const canonicalValues: Record<string, string> = {};
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        if (typeof v === 'string') canonicalValues[k] = v;
      }
    }
    return [{
      type:            row.type,
      validationMode:  typeof row.validation_mode === 'string' ? row.validation_mode : null,
      dossierEligible: typeof row.dossier_eligible === 'boolean' ? row.dossier_eligible : null,
      canonicalValues,
    }];
  });
}
