/**
 * Mirror the watchlist onto Distill's dossier switches.
 *
 * Distill builds a dossier only while an entity's switch is on, and each one
 * costs money per day — so the switch has to follow the watchlist rather than
 * be set by hand: stock added → dossier on, stock gone → dossier off. Since the
 * switch also gates the whole build upstream, this is not an optimisation; it
 * is what feeds the dossier system at all.
 *
 * Three rules shape everything here:
 *
 *  1. **The watchlist is the truth, Distill follows it.** A failed switch never
 *     fails the add or the delete that caused it. The intent is written to the
 *     ledger first and retried by the next full sync.
 *  2. **The switch is idempotent in both directions**, so a full sync may be
 *     blunt. What the ledger buys us is not correctness but cost: it keeps the
 *     sync from re-searching the registry for symbols it already resolved.
 *  3. **Off deletes nothing.** Existing dossiers stand; they just stop being
 *     extended. A stock that comes back still has its history — which is why
 *     switching off on delete is safe to do eagerly.
 *
 * Layering: `data/distill-dossier.ts` is the transport, `db/admin.ts` the
 * ledger, this module the policy. The entity resolver is not re-implemented —
 * `distill-service.ts` already owns the UUID cache, the tier policy and merge
 * following, and this module borrows it.
 */

import { getConfig } from './config.js';
import { AppConfig, isWatched, readAppConfig } from './app-config.js';
import {
  clearDistillEntity,
  DossierLedgerRow,
  DossierState,
  listDossiers,
  readDistillEntity,
  readDossier,
  recordDossierIntent,
  recordDossierOutcome,
  retireDossiers,
} from './db/admin.js';
import { listSymbols, readFinancialsLax } from './db/store.js';
import { scheduledSymbols } from './pipeline/steps.js';
import { distillHintsFor, resolveDistillEntityCached } from './distill-service.js';
import { setDistillDossier } from './data/distill-dossier.js';
import {
  DistillDossierIneligibleError,
  DistillDossierScopeError,
  DistillEntityGoneError,
  DistillEntityUnresolvedError,
  DistillUnauthorizedError,
} from './data/distill-errors.js';
import { logger } from './utils/logger.js';

/** One watchlist movement, in the direction Distill should end up in. */
export interface DossierChange {
  symbol:  string;
  enabled: boolean;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** The entity a symbol maps to, or why it has none. */
export interface ResolvedEntity {
  id:     string | null;
  detail: string | null;
}

/**
 * Symbol → entity UUID, through the existing cache.
 *
 * Unlike the briefings path this reports "no entity" as a *state* rather than
 * throwing: a company Distill's registry has never heard of is a normal thing
 * for a screener to hold, and it must not look like a broken sync. The state is
 * written to the ledger so the next full run retries it instead of every config
 * save re-searching the same misses.
 */
export async function resolveEntityId(
  symbol: string, opts: { force?: boolean } = {},
): Promise<ResolvedEntity> {
  const cfg = getConfig();
  if (!cfg.distillApiKey) return { id: null, detail: 'DISTILL_API_KEY not set' };

  try {
    const financials = await readFinancialsLax(symbol);
    const entity = await resolveDistillEntityCached(
      distillHintsFor(symbol, financials),
      cfg.distillApiKey,
      cfg.distillApiUrl,
      opts,
    );
    return { id: entity.id, detail: null };
  } catch (e) {
    if (e instanceof DistillEntityUnresolvedError) return { id: null, detail: e.message };
    throw e;
  }
}

/** Set the switch on one entity. Idempotent; throws the typed failures. */
export async function setDossier(entityId: string, enabled: boolean): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg.distillApiKey) throw new DistillUnauthorizedError();
  const state = await setDistillDossier(entityId, enabled, cfg.distillApiKey, cfg.distillApiUrl);
  return state.enabled;
}

// ── Planning ─────────────────────────────────────────────────────────────────

export interface DossierAction {
  symbol:   string;
  enabled:  boolean;
  /** Known id, when the ledger already holds one. Null means "resolve first". */
  entityId: string | null;
}

export interface DossierPlan {
  actions: DossierAction[];
  /** Rows with nothing left to say — off and confirmed, or never on. */
  retire:  string[];
  /** Rows already in the state we want. */
  settled: number;
  skipped: { symbol: string; reason: string }[];
}

/**
 * Decide what a sync has to send. Pure — the whole state machine in one place,
 * which is what makes "does a second sync send anything?" a question a test can
 * answer without a database or a server.
 *
 * The pivot is `applied`: what Distill last *confirmed*, not what we last
 * wanted. A row whose switch is confirmed on and whose symbol is still watched
 * needs no call, and that is the entire reason a repeated sync is quiet.
 */
export function planDossierSync(
  watched: Iterable<string>,
  ledger: readonly DossierLedgerRow[],
): DossierPlan {
  const want = new Set([...watched].map((s) => s.toUpperCase()));
  const rows = new Map(ledger.map((r) => [r.symbol.toUpperCase(), r]));

  const plan: DossierPlan = { actions: [], retire: [], settled: 0, skipped: [] };

  for (const symbol of want) {
    const row = rows.get(symbol);
    if (row?.applied === true) { plan.settled++; continue; }
    // 409 is a property of the entity's type, so asking again cannot change it.
    if (row?.state === 'ineligible') {
      plan.skipped.push({ symbol, reason: row.detail ?? 'entity may not host a dossier' });
      continue;
    }
    plan.actions.push({ symbol, enabled: true, entityId: row?.entityId ?? null });
  }

  for (const row of ledger) {
    const symbol = row.symbol.toUpperCase();
    if (want.has(symbol)) continue;
    // Only a switch Distill confirmed as on is worth switching off. Anything
    // else — never resolved, never accepted, already off — has no upstream
    // state to undo, so the row simply goes.
    if (row.applied === true) plan.actions.push({ symbol, enabled: false, entityId: row.entityId });
    else plan.retire.push(symbol);
  }

  return plan;
}

// ── Applying ─────────────────────────────────────────────────────────────────

export interface SwitchOutcome {
  entityId: string | null;
  applied:  boolean | null;
  state:    DossierState;
  detail:   string | null;
}

/**
 * What a failed switch means for the ledger. Three outcomes, because the four
 * status codes Distill uses are genuinely three different actions:
 *
 *   401 / 403 → `abort`      the key is wrong or unscoped; every remaining
 *                            symbol fails identically, so stop and say it once
 *   404       → `re-resolve` the id is stale, never the request; look the
 *                            entity up again and try that, exactly once
 *   409       → `record`     the entity's type may not host a dossier. A
 *                            standing condition, not a failure: written down
 *                            and skipped from then on rather than retried
 *   5xx / net → `record`     already retried with backoff in the transport;
 *                            left pending so the next full sync picks it up
 */
export type DossierFailure =
  | { kind: 'abort';      error: Error }
  | { kind: 're-resolve' }
  | { kind: 'record';     outcome: SwitchOutcome };

export function classifyDossierFailure(e: unknown, entityId: string | null): DossierFailure {
  if (e instanceof DistillDossierScopeError || e instanceof DistillUnauthorizedError) {
    return { kind: 'abort', error: e };
  }
  if (e instanceof DistillEntityGoneError) return { kind: 're-resolve' };
  if (e instanceof DistillDossierIneligibleError) {
    return { kind: 'record', outcome: { entityId, applied: null, state: 'ineligible', detail: e.message } };
  }
  return {
    kind:    'record',
    outcome: { entityId, applied: null, state: 'pending', detail: (e as Error).message },
  };
}

/**
 * The entity behind a symbol is gone from the registry.
 *
 * Switching *off* is then already true — Distill cannot be building a dossier
 * for an entity it does not have — so the row settles rather than retrying a
 * call that can only 404 again, every sync, forever. Switching *on* stays
 * unresolved and the next run tries to resolve it afresh.
 */
function entityGone(enabled: boolean, detail: string | null): SwitchOutcome {
  return enabled
    ? { entityId: null, applied: null,  state: 'unresolved', detail }
    : { entityId: null, applied: false, state: 'synced',
        detail: detail ?? 'entity no longer exists in Distill — nothing left to switch off' };
}

/**
 * Push one switch, resolving the entity when we do not have it yet.
 *
 * A 404 is never retried verbatim: the id is re-resolved first (which follows a
 * merge) and the call repeated exactly once. 403 and 401 are re-thrown — they
 * are properties of the key, so every remaining symbol would fail the same way
 * and the sync should stop rather than mark forty stocks as broken.
 */
async function pushSwitch(symbol: string, enabled: boolean, known: string | null): Promise<SwitchOutcome> {
  let entityId = known;

  if (!entityId) {
    // Switching *off* something we never resolved is a no-op upstream — and
    // searching the registry for a stock that is being deleted would be an odd
    // way to spend a request.
    if (!enabled) return { entityId: null, applied: false, state: 'synced', detail: 'never switched on' };
    const resolved = await resolveEntityId(symbol);
    if (!resolved.id) return { entityId: null, applied: null, state: 'unresolved', detail: resolved.detail };
    entityId = resolved.id;
  }

  try {
    return { entityId, applied: await setDossier(entityId, enabled), state: 'synced', detail: null };
  } catch (e) {
    const failure = classifyDossierFailure(e, entityId);
    if (failure.kind === 'abort')  throw failure.error;
    if (failure.kind === 'record') return failure.outcome;

    // 404: the id, not the request. Drop the mapping, resolve afresh — which
    // follows a merge — and try once more. A second 404 is not retried again.
    logger.warn(`Distill no longer knows ${entityId} (${symbol}) — re-resolving before retrying.`);
    await clearDistillEntity(symbol);
    const fresh = await resolveEntityId(symbol, { force: true });
    if (!fresh.id) return entityGone(enabled, fresh.detail);

    try {
      return { entityId: fresh.id, applied: await setDossier(fresh.id, enabled), state: 'synced', detail: null };
    } catch (retry) {
      const second = classifyDossierFailure(retry, fresh.id);
      if (second.kind === 'abort')  throw second.error;
      if (second.kind === 'record') return second.outcome;
      return entityGone(enabled, `Distill 404s the re-resolved id ${fresh.id} too`);
    }
  }
}

/** The id we already hold for a symbol: the ledger first, then the entity cache. */
async function knownEntityId(symbol: string, baseUrl: string): Promise<string | null> {
  const row = await readDossier(symbol, baseUrl);
  if (row?.entityId) return row.entityId;
  const cached = await readDistillEntity(symbol, baseUrl);
  return cached?.id ?? null;
}

// ── The two entry points ─────────────────────────────────────────────────────

/**
 * Write down what the watchlist now says, without sending anything.
 *
 * The one place ordering genuinely matters. Deleting a stock cascades its
 * `distill_entities` row away, so the entity id has to be copied into the
 * ledger — which does not cascade — *before* the delete. Once it is there the
 * call itself can happen after the response, or not until the next full sync,
 * and the off-switch still lands.
 */
export async function noteDossierIntent(changes: readonly DossierChange[]): Promise<void> {
  const cfg = getConfig();
  if (!cfg.distillApiKey || changes.length === 0) return;

  for (const change of changes) {
    const symbol = change.symbol.toUpperCase();
    try {
      await recordDossierIntent(cfg.distillApiUrl, symbol, change.enabled, await knownEntityId(symbol, cfg.distillApiUrl));
    } catch (e) {
      logger.warn(`Could not record the Distill dossier intent for ${symbol}: ${(e as Error).message}`);
    }
  }
}

/**
 * A watchlist movement happened: mirror it now.
 *
 * Never throws, by contract. Adding or deleting a stock must not fail because
 * Distill is down — the intent is on disk before the first request goes out, so
 * the next full sync finishes the job.
 *
 * Call it *before* deleting a symbol: the entity mapping lives in
 * `distill_entities`, which cascades away with the row, and the ledger's own
 * copy of the id is what lets the off-switch survive that.
 */
export async function dossiersFollow(changes: readonly DossierChange[]): Promise<void> {
  if (changes.length === 0) return;

  const cfg = getConfig();
  if (!cfg.distillApiKey) {
    logger.debug('Distill dossier switch skipped — DISTILL_API_KEY not set.');
    return;
  }
  const baseUrl = cfg.distillApiUrl;

  for (const change of changes) {
    const symbol = change.symbol.toUpperCase();
    try {
      const known = await knownEntityId(symbol, baseUrl);
      await recordDossierIntent(baseUrl, symbol, change.enabled, known);

      const outcome = await pushSwitch(symbol, change.enabled, known);
      await recordDossierOutcome(baseUrl, symbol, change.enabled, outcome);

      if (outcome.state === 'synced') {
        logger.info(`Distill dossier ${change.enabled ? 'on' : 'off'} for ${symbol}${outcome.entityId ? ` (${outcome.entityId})` : ''}`);
      } else {
        // `ineligible` is a standing condition, not a backlog item — saying it
        // will be retried would be a lie the next sync does not tell either.
        const next = outcome.state === 'ineligible'
          ? 'It will be skipped from now on.'
          : 'The next full sync retries it.';
        logger.warn(`Distill dossier for ${symbol} left ${outcome.state}: ${outcome.detail ?? 'no detail'} — ${next}`);
      }
    } catch (e) {
      // Including the key-level failures: they abort a *sync*, but here there is
      // nothing to abort, and the watchlist write must not notice either way.
      logger.error(`Distill dossier switch for ${symbol} failed: ${(e as Error).message}`);
      await recordDossierOutcome(baseUrl, symbol, change.enabled, {
        entityId: null, applied: null,
        state:    e instanceof DistillDossierScopeError ? 'forbidden' : 'pending',
        detail:   (e as Error).message,
      }).catch(() => { /* the ledger is best-effort; the sync reconciles anyway */ });
    }
  }
}

export interface DossierSyncSummary {
  enabled:    number;
  disabled:   number;
  settled:    number;
  unresolved: number;
  ineligible: number;
  failed:     number;
  retired:    number;
  /** Set when the sync could not run or had to stop — the reason, verbatim. */
  aborted:    string | null;
}

const EMPTY_SUMMARY: DossierSyncSummary = {
  enabled: 0, disabled: 0, settled: 0, unresolved: 0,
  ineligible: 0, failed: 0, retired: 0, aborted: null,
};

/** One line for the run log and the API. */
export function describeDossierSync(s: DossierSyncSummary): string {
  if (s.aborted) return `aborted — ${s.aborted}`;
  const parts = [`${s.enabled} on`, `${s.disabled} off`, `${s.settled} unchanged`];
  if (s.unresolved) parts.push(`${s.unresolved} unresolved`);
  if (s.ineligible) parts.push(`${s.ineligible} ineligible`);
  if (s.failed)     parts.push(`${s.failed} failed`);
  if (s.retired)    parts.push(`${s.retired} retired`);
  return parts.join(', ');
}

/**
 * Mirror the whole watchlist onto Distill.
 *
 * Runs at the start of every pipeline run rather than on a cron of its own. The
 * event-driven path above already keeps Distill current within seconds of a
 * change; what this adds is repair — the switch that failed while Distill was
 * down, the symbol the registry did not know last week, the row nobody wrote
 * because the process died between the two. Tying it to the run means it
 * happens exactly when the night's work is about to depend on it, and never
 * competes with a run for the same key.
 */
export async function syncWatchlistDossiers(config?: AppConfig): Promise<DossierSyncSummary> {
  const cfg = getConfig();
  if (!cfg.distillApiKey) return { ...EMPTY_SUMMARY, aborted: 'DISTILL_API_KEY not set' };

  const baseUrl = cfg.distillApiUrl;
  const appConfig = config ?? await readAppConfig();
  const [watched, ledger] = await Promise.all([
    scheduledSymbols(appConfig),
    listDossiers(baseUrl),
  ]);

  const plan = planDossierSync(watched, ledger);
  const summary: DossierSyncSummary = { ...EMPTY_SUMMARY, settled: plan.settled };
  for (const s of plan.skipped) {
    summary.ineligible++;
    logger.debug(`Distill dossier for ${s.symbol} skipped: ${s.reason}`);
  }

  // Enables first, and their entity ids are remembered: two symbols can share
  // one entity (a dual listing), and a per-entity switch cannot be both on and
  // off. The watched side wins — the other row is retired rather than fighting
  // it on every sync.
  const enabledEntities = new Set<string>();
  const ordered = [...plan.actions].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const retire = [...plan.retire];

  for (const action of ordered) {
    if (!action.enabled && action.entityId && enabledEntities.has(action.entityId)) {
      logger.info(`Distill dossier for ${action.symbol} stays on — entity ${action.entityId} is also watched under another symbol.`);
      retire.push(action.symbol);
      continue;
    }

    let outcome: SwitchOutcome;
    try {
      await recordDossierIntent(baseUrl, action.symbol, action.enabled, action.entityId);
      outcome = await pushSwitch(action.symbol, action.enabled, action.entityId);
    } catch (e) {
      // Key-level: the remaining symbols would fail identically, so stop and say
      // so once instead of writing the same error onto the whole watchlist.
      summary.aborted = (e as Error).message;
      await recordDossierOutcome(baseUrl, action.symbol, action.enabled, {
        entityId: action.entityId, applied: null,
        state:    e instanceof DistillDossierScopeError ? 'forbidden' : 'pending',
        detail:   (e as Error).message,
      }).catch(() => { /* best effort */ });
      logger.error(`Distill dossier sync stopped at ${action.symbol}: ${(e as Error).message}`);
      break;
    }

    await recordDossierOutcome(baseUrl, action.symbol, action.enabled, outcome);

    if (outcome.state === 'synced') {
      if (action.enabled) { summary.enabled++; if (outcome.entityId) enabledEntities.add(outcome.entityId); }
      else summary.disabled++;
    } else if (outcome.state === 'unresolved') {
      summary.unresolved++;
    } else if (outcome.state === 'ineligible') {
      summary.ineligible++;
    } else {
      summary.failed++;
    }
  }

  if (retire.length > 0) {
    await retireDossiers(baseUrl, retire);
    summary.retired = retire.length;
  }

  logger.info(`Distill dossier sync — ${describeDossierSync(summary)}`);
  return summary;
}

/**
 * Which symbols changed sides between two configs.
 *
 * Derived from `listSymbols()` rather than from the watchlist record's keys:
 * the record is an *opt-out*, so an absent key means watched, and diffing the
 * keys alone would miss every stock that was never toggled.
 */
export async function watchlistDelta(before: AppConfig, after: AppConfig): Promise<DossierChange[]> {
  const symbols = await listSymbols();
  return symbols
    .filter((s) => isWatched(before, s) !== isWatched(after, s))
    .map((s) => ({ symbol: s, enabled: isWatched(after, s) }));
}
