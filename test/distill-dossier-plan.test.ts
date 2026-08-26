/**
 * What a sync decides to send, and what it does with what comes back.
 *
 * Both are pure functions on purpose — the interesting questions here ("does a
 * second sync send anything?", "is a 409 retried?") are policy, and policy that
 * needs a database and a live Distill to interrogate is policy nobody checks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyDossierFailure,
  planDossierSync,
} from '../src/distill-dossiers.js';
import type { DossierLedgerRow, DossierState } from '../src/db/admin.js';
import {
  DistillDossierIneligibleError,
  DistillDossierScopeError,
  DistillEntityGoneError,
  DistillUnauthorizedError,
} from '../src/data/distill-errors.js';

function row(symbol: string, over: Partial<DossierLedgerRow> = {}): DossierLedgerRow {
  return {
    symbol,
    entityId:    `entity-${symbol.toLowerCase()}`,
    desired:     true,
    applied:     true,
    state:       'synced' as DossierState,
    detail:      null,
    attempts:    0,
    attemptedAt: '2026-08-26T00:00:00.000Z',
    syncedAt:    '2026-08-26T00:00:00.000Z',
    ...over,
  };
}

describe('planDossierSync', () => {
  it('switches on everything the watchlist holds when the ledger is empty', () => {
    const plan = planDossierSync(['AAPL', 'MSFT'], []);

    assert.deepEqual(plan.actions, [
      { symbol: 'AAPL', enabled: true, entityId: null },
      { symbol: 'MSFT', enabled: true, entityId: null },
    ]);
    assert.equal(plan.settled, 0);
    assert.deepEqual(plan.retire, []);
  });

  it('sends nothing the second time — this is what makes the sync cheap to repeat', () => {
    const ledger = [row('AAPL'), row('MSFT')];

    const plan = planDossierSync(['AAPL', 'MSFT'], ledger);

    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.retire, []);
    assert.equal(plan.settled, 2);
  });

  it('reuses the id it already has instead of resolving the symbol again', () => {
    // Confirmed off, now watched again: one call, no search.
    const ledger = [row('AAPL', { applied: false, desired: false })];

    const plan = planDossierSync(['AAPL'], ledger);

    assert.deepEqual(plan.actions, [{ symbol: 'AAPL', enabled: true, entityId: 'entity-aapl' }]);
  });

  it('switches off a stock that left the watchlist', () => {
    const plan = planDossierSync(['AAPL'], [row('AAPL'), row('MSFT')]);

    assert.deepEqual(plan.actions, [{ symbol: 'MSFT', enabled: false, entityId: 'entity-msft' }]);
    assert.equal(plan.settled, 1);
  });

  it('retires a departed stock that was never switched on, rather than calling about it', () => {
    // The delete path writes an intent for every stock; most were never on.
    const ledger = [row('FOO', { applied: null, desired: false, state: 'pending' })];

    const plan = planDossierSync([], ledger);

    assert.deepEqual(plan.actions, [], 'nothing upstream to undo');
    assert.deepEqual(plan.retire, ['FOO']);
  });

  it('retires a departed stock whose switch is already confirmed off', () => {
    const plan = planDossierSync([], [row('FOO', { applied: false, desired: false })]);

    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.retire, ['FOO']);
  });

  it('leaves an ineligible entity alone — its type will not change because we asked twice', () => {
    const ledger = [row('BTC', { applied: null, state: 'ineligible', detail: 'type not a dossier subject' })];

    const plan = planDossierSync(['BTC'], ledger);

    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.skipped, [{ symbol: 'BTC', reason: 'type not a dossier subject' }]);
  });

  it('retries a symbol Distill did not know, but only on a run — not on every save', () => {
    const ledger = [row('OBSCURE', { entityId: null, applied: null, state: 'unresolved', detail: 'no hit' })];

    const plan = planDossierSync(['OBSCURE'], ledger);

    assert.deepEqual(plan.actions, [{ symbol: 'OBSCURE', enabled: true, entityId: null }]);
  });

  it('retries a switch that failed in transit', () => {
    const ledger = [row('AAPL', { applied: null, state: 'pending', detail: 'Distill dossier write error 503', attempts: 1 })];

    const plan = planDossierSync(['AAPL'], ledger);

    assert.deepEqual(plan.actions, [{ symbol: 'AAPL', enabled: true, entityId: 'entity-aapl' }]);
  });

  it('matches the ledger case-insensitively, the way the rest of the app treats symbols', () => {
    const plan = planDossierSync(['aapl'], [row('AAPL')]);

    assert.deepEqual(plan.actions, []);
    assert.equal(plan.settled, 1);
  });
});

describe('classifyDossierFailure', () => {
  it('403 aborts the sync — the scope is a property of the key, not of the symbol', () => {
    const f = classifyDossierFailure(new DistillDossierScopeError(), 'entity-1');
    assert.equal(f.kind, 'abort');
  });

  it('401 aborts too, and keeps its own message', () => {
    const f = classifyDossierFailure(new DistillUnauthorizedError(), 'entity-1');
    assert.equal(f.kind, 'abort');
    assert.match((f as { error: Error }).error.message, /DISTILL_API_KEY/);
  });

  it('404 asks for a re-resolve rather than a repeat of the same call', () => {
    const f = classifyDossierFailure(new DistillEntityGoneError('entity-1'), 'entity-1');
    assert.equal(f.kind, 're-resolve');
  });

  it('409 is recorded as a standing condition, so later syncs skip it', () => {
    const f = classifyDossierFailure(new DistillDossierIneligibleError('entity-1'), 'entity-1');
    assert.equal(f.kind, 'record');
    assert.equal((f as { outcome: { state: string } }).outcome.state, 'ineligible');
  });

  it('anything else is left pending, which is what the next full sync picks up', () => {
    const f = classifyDossierFailure(new Error('Distill dossier write error 503: boom'), 'entity-1');
    assert.equal(f.kind, 'record');

    const outcome = (f as { outcome: { state: string; applied: boolean | null; detail: string | null } }).outcome;
    assert.equal(outcome.state, 'pending');
    assert.equal(outcome.applied, null, 'nothing was confirmed, so nothing is claimed');
    assert.match(outcome.detail!, /503/);
  });

  it('never confuses the three: 403, 404 and 409 land in three different places', () => {
    const kinds = [
      classifyDossierFailure(new DistillDossierScopeError(), null).kind,
      classifyDossierFailure(new DistillEntityGoneError('e'), null).kind,
      classifyDossierFailure(new DistillDossierIneligibleError('e'), null).kind,
    ];
    assert.deepEqual(kinds, ['abort', 're-resolve', 'record']);
  });
});
