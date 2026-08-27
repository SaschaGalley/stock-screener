/**
 * Distill orchestration: identifier → entity UUID → briefings.
 *
 * Sits above both the cache and the two Distill clients, which is what lets it
 * own the one piece of state that matters — the persistent mapping from our
 * identifiers (ISIN, Yahoo symbol, company name) to Distill's opaque entity
 * UUID. Everything below stays free of that dependency: `data/distill*.ts` is
 * pure HTTP, `cache.ts` is pure filesystem.
 *
 * Two rules from Distill's registry migration are implemented here:
 *  1. Cache the UUID, not a ref string. Handles change on rename, tickers are
 *     not globally unique, names least of all.
 *  2. A 404 is never retried verbatim. The id gets re-resolved first — via
 *     `GET /entities/{id}` (which follows merges and reports non-active
 *     statuses), falling back to a fresh tiered search.
 */

import { logger } from './utils/logger.js';
import { clearDistillEntity, readDistillEntity, writeDistillEntity } from './db/admin.js';
import { readDistillLax, writeDistill } from './db/store.js';
import {
  DistillEntityHints,
  DistillEntityHit,
  DistillEntityRef,
  getDistillEntity,
  resolveDistillEntity,
} from './data/distill-entities.js';
import { DistillEntityGoneError, DistillEntityUnresolvedError } from './data/distill-errors.js';

export type { DistillEntityHints, DistillEntityRef } from './data/distill-entities.js';

/**
 * Build the identifier set for a symbol. ISIN first when we have one — it is
 * the only identifier guaranteed to be globally unique, and the only way a
 * ticker collision resolves without a human.
 */
export function distillHintsFor(
  symbol: string,
  financials?: { companyName?: string | null; isin?: string | null } | null,
): DistillEntityHints {
  return {
    symbol,
    isin:        financials?.isin ?? null,
    companyName: financials?.companyName ?? null,
  };
}

/** Compact one-line rendering of candidates for logs and API errors. */
function describeCandidates(candidates: DistillEntityHit[]): string {
  return candidates
    .map((c) => {
      const extra = [c.primarySymbol, c.country, c.isin].filter(Boolean).join(', ');
      return `${c.displayName}${extra ? ` (${extra})` : ''} [${c.id}]`;
    })
    .join(' · ');
}

/**
 * Resolve a symbol to its entity UUID, hitting the persistent cache first.
 * Throws `DistillEntityUnresolvedError` when the identifiers we hold cannot
 * pin down exactly one entity — a `name`-tier match is reported as ambiguous
 * rather than taken, because a wrong entity silently feeds another company's
 * briefing into the analysis prompt.
 */
export async function resolveDistillEntityCached(
  hints: DistillEntityHints,
  apiKey: string,
  baseUrl: string,
  opts: { force?: boolean } = {},
): Promise<DistillEntityRef> {
  if (!opts.force) {
    const cached = await readDistillEntity(hints.symbol, baseUrl);
    if (cached) return cached;
  }

  const resolution = await resolveDistillEntity(hints, apiKey, baseUrl);

  if (resolution.status === 'resolved') {
    await writeDistillEntity(hints.symbol, resolution.entity);
    return resolution.entity;
  }

  if (resolution.status === 'ambiguous') {
    const tier = resolution.candidates[0]?.matchedOn ?? 'name';
    throw new DistillEntityUnresolvedError({
      reason:     'ambiguous',
      symbol:     hints.symbol,
      candidates: resolution.candidates,
      message:
        `Distill entity for ${hints.symbol} is ambiguous: "${resolution.query}" matched only on tier `
        + `"${tier}" (${resolution.candidates.length} candidate(s)) — ${describeCandidates(resolution.candidates)}. `
        + `Add the ISIN or pick the entity in Distill; guessing would attach another company's briefing.`,
    });
  }

  throw new DistillEntityUnresolvedError({
    reason:  'not-found',
    symbol:  hints.symbol,
    message: `No Distill entity found for ${hints.symbol} (tried: ${resolution.queries.join(', ') || 'nothing'}).`,
  });
}

type Revalidation =
  /** Same id, still active — the mapping is fine. */
  | { status: 'unchanged'; entity: DistillEntityRef }
  /** The entity was merged; `entity` is the merge root and the cache is updated. */
  | { status: 'replaced';  entity: DistillEntityRef }
  /** 404 — the id is truly gone and the cache entry has been dropped. */
  | { status: 'gone' };

/**
 * Ask `GET /entities/{id}` what became of a cached id.
 *
 * It answers the two questions a bad id leaves open. It resolves to the *merge
 * root*, so an id differing from ours means ours was superseded and must be
 * replaced. And it reports every status — search only ever emits `active`, so
 * a `quarantined`/`rejected` entity is the explanation when a mapping that
 * used to work stops producing briefings.
 */
async function revalidateEntity(
  hints: DistillEntityHints,
  entity: DistillEntityRef,
  apiKey: string,
  baseUrl: string,
): Promise<Revalidation> {
  const detail = await getDistillEntity(entity.id, apiKey, baseUrl);

  if (!detail) {
    await clearDistillEntity(hints.symbol);
    return { status: 'gone' };
  }

  if (detail.id !== entity.id) {
    const merged: DistillEntityRef = {
      ...entity,
      id:          detail.id,
      ref:         detail.ref || entity.ref,
      type:        detail.type || entity.type,
      displayName: detail.displayName || entity.displayName,
      resolvedAt:  new Date().toISOString(),
    };
    await writeDistillEntity(hints.symbol, merged);
    logger.warn(`Distill entity ${entity.id} was merged into ${detail.id} (${merged.displayName}) — cache updated.`);
    return { status: 'replaced', entity: merged };
  }

  if (detail.status && detail.status !== 'active') {
    throw new DistillEntityUnresolvedError({
      reason:       'inactive',
      symbol:       hints.symbol,
      entityStatus: detail.status,
      message:
        `Distill entity ${detail.id} (${detail.displayName}) is "${detail.status}" and serves no briefings. `
        + `Reactivate it in Distill or map ${hints.symbol} to a different entity.`,
    });
  }

  return { status: 'unchanged', entity };
}

/** Recover from a 404 on an id we sent: follow a merge, else resolve afresh. */
async function recoverDistillEntity(
  hints: DistillEntityHints,
  stale: DistillEntityRef,
  apiKey: string,
  baseUrl: string,
): Promise<DistillEntityRef> {
  const check = await revalidateEntity(hints, stale, apiKey, baseUrl);
  if (check.status === 'replaced') return check.entity;

  // Either the id is unknown, or it looks healthy yet the call still rejected
  // it — in both cases the mapping is what we distrust, so drop it and resolve
  // from the identifiers again.
  await clearDistillEntity(hints.symbol);
  return resolveDistillEntityCached(hints, apiKey, baseUrl, { force: true });
}

/**
 * Resolve, call, and — on a 404 for the id — re-resolve and retry exactly once.
 *
 * Exported because every Distill call that takes an entity id needs the same
 * recovery, and `GET /entities/{id}` is the only thing that follows a merge:
 * re-searching from the identifiers would find the merge root only by luck.
 */
export async function withResolvedEntity<T>(
  hints: DistillEntityHints,
  apiKey: string,
  baseUrl: string,
  call: (entity: DistillEntityRef) => Promise<T>,
): Promise<{ value: T; entity: DistillEntityRef }> {
  const entity = await resolveDistillEntityCached(hints, apiKey, baseUrl);
  try {
    return { value: await call(entity), entity };
  } catch (e) {
    if (!(e instanceof DistillEntityGoneError)) throw e;
    logger.warn(`Distill returned 404 for ${hints.symbol} → ${entity.id}; re-resolving instead of retrying.`);
    const recovered = await recoverDistillEntity(hints, entity, apiKey, baseUrl);
    // Single retry: if the freshly resolved id 404s too, the error propagates.
    return { value: await call(recovered), entity: recovered };
  }
}
