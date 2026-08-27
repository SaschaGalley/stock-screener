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

/** The configured token is missing/invalid (401). Distinct from 403 (key
 *  exists but lacks `briefings:write`) so the UI can guide the user to the
 *  right fix (rotate the env var vs. rescope the existing key). */
export class DistillUnauthorizedError extends Error {
  constructor(msg = 'Distill key is missing or invalid — check DISTILL_API_KEY in your .env.') {
    super(msg);
    this.name = 'DistillUnauthorizedError';
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

/**
 * 403 on the dossier switch — the key exists but was minted without
 * `dossiers:write`.
 *
 * Never retried, and it stops the whole sync rather than just the symbol that
 * hit it: the scope is a property of the key, so every remaining symbol would
 * fail identically. The fix is to re-issue the key in the Distill admin.
 */
export class DistillDossierScopeError extends Error {
  constructor(msg = 'Distill key lacks the `dossiers:write` scope — re-issue it in the Distill admin (Projekt-Config → Access Keys) with that box ticked.') {
    super(msg);
    this.name = 'DistillDossierScopeError';
  }
}

/**
 * 409 on the dossier switch — this entity's *type* is not allowed to be a
 * dossier subject.
 *
 * A property of the entity, not of the request, so it is a standing condition
 * rather than a failure: recorded once and skipped from then on. Distinct from
 * a transport error, which is retried, and from a 404, which re-resolves.
 */
export class DistillDossierIneligibleError extends Error {
  constructor(readonly entityId: string, msg?: string) {
    super(msg ?? `Distill will not host a dossier on entity ${entityId} — its type is not an allowed subject.`);
    this.name = 'DistillDossierIneligibleError';
  }
}
