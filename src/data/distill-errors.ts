/**
 * Typed Distill failures.
 *
 * These live in their own module so the briefings client (`distill.ts`) and the
 * entity-registry client (`distill-entities.ts`) can throw the same classes
 * without importing each other. `distill.ts` re-exports them, so existing
 * `import { DistillReadOnlyError } from './data/distill.js'` call sites keep
 * working and `instanceof` stays sound (one class, one module).
 */

import type { DistillEntityHit } from './distill-entities.js';

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
 * Distill answered 404 for an entity id we sent. Recoverable, and NOT to be
 * retried verbatim: the entity was deleted, or the handle we cached is stale.
 * The caller re-resolves the identifier (via `GET /entities/{ref}` for the
 * merge root, else a fresh search) and retries exactly once.
 */
export class DistillEntityGoneError extends Error {
  constructor(readonly entityId: string, msg?: string) {
    super(msg ?? `Distill no longer knows entity ${entityId} — re-resolving.`);
    this.name = 'DistillEntityGoneError';
  }
}

/** Why an identifier could not be turned into a usable entity UUID. */
export type DistillUnresolvedReason =
  /** Search returned hits, but only on tiers we must not accept blindly. */
  | 'ambiguous'
  /** No hit on any identifier we hold (ISIN, symbol, name). */
  | 'not-found'
  /** The entity exists but is `quarantined`/`rejected`, so it serves no briefings. */
  | 'inactive';

/**
 * Terminal resolution failure — we have no UUID to call the briefings API with.
 * Non-fatal for an analysis run (Distill is optional context), but the server
 * surfaces `candidates` so a human can pick the right entity instead of
 * guessing at a `name`-tier match on our behalf.
 */
export class DistillEntityUnresolvedError extends Error {
  readonly reason:       DistillUnresolvedReason;
  readonly symbol:       string;
  readonly candidates:   DistillEntityHit[];
  readonly entityStatus: string | null;

  constructor(opts: {
    reason:        DistillUnresolvedReason;
    symbol:        string;
    message:       string;
    candidates?:   DistillEntityHit[];
    entityStatus?: string | null;
  }) {
    super(opts.message);
    this.name         = 'DistillEntityUnresolvedError';
    this.reason       = opts.reason;
    this.symbol       = opts.symbol;
    this.candidates   = opts.candidates ?? [];
    this.entityStatus = opts.entityStatus ?? null;
  }
}
