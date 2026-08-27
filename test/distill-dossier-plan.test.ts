/**
 * What a sync decides to send, and what it does with what comes back.
 *
 * Both are pure functions on purpose — the interesting questions here ("does a
 * second sync send anything?", "is a 409 retried?", "does a sector go off when
 * its last stock leaves?") are policy, and policy that needs a database and a
 * live Distill to interrogate is policy nobody checks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyDossierFailure,
  planDossierSync,
} from '../src/distill-dossiers.js';
import type { DossierKind, DossierLedgerRow, DossierState, DossierSubject } from '../src/db/admin.js';
import {
  DistillDossierIneligibleError,
  DistillDossierScopeError,
  DistillEntityGoneError,
  DistillUnauthorizedError,
} from '../src/data/distill-errors.js';

const company = (subject: string): DossierSubject => ({ kind: 'company', subject });
const sector  = (subject: string): DossierSubject => ({ kind: 'sector',  subject });

function row(
  kind: DossierKind, subject: string, over: Partial<DossierLedgerRow> = {},
): DossierLedgerRow {
  return {
    kind,
    subject,
    entityId:    `entity-${subject.toLowerCase()}`,
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
  it('switches on everything wanted when the ledger is empty', () => {
    const plan = planDossierSync([company('AAPL'), sector('information_technology')], []);

    assert.deepEqual(plan.actions, [
      { kind: 'company', subject: 'AAPL', enabled: true, entityId: null },
      { kind: 'sector', subject: 'information_technology', enabled: true, entityId: null },
    ]);
    assert.equal(plan.settled, 0);
  });

  it('sends nothing the second time — this is what makes the sync cheap to repeat', () => {
    const ledger = [row('company', 'AAPL'), row('sector', 'information_technology')];

    const plan = planDossierSync([company('AAPL'), sector('information_technology')], ledger);

    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.retire, []);
    assert.equal(plan.settled, 2);
  });

  it('reuses the id it already has instead of resolving the subject again', () => {
    const ledger = [row('company', 'AAPL', { applied: false, desired: false })];

    const plan = planDossierSync([company('AAPL')], ledger);

    assert.deepEqual(plan.actions, [
      { kind: 'company', subject: 'AAPL', enabled: true, entityId: 'entity-aapl' },
    ]);
  });

  it('switches off a stock that left the watchlist', () => {
    const plan = planDossierSync([company('AAPL')], [row('company', 'AAPL'), row('company', 'MSFT')]);

    assert.deepEqual(plan.actions, [
      { kind: 'company', subject: 'MSFT', enabled: false, entityId: 'entity-msft' },
    ]);
    assert.equal(plan.settled, 1);
  });

  it('switches off a sector once no watched stock sits in it any more', () => {
    // The whole reason sectors are derived rather than switched on once: the
    // last utility leaving the watchlist has to stop that dossier billing.
    const ledger = [row('company', 'AAPL'), row('sector', 'utilities')];

    const plan = planDossierSync([company('AAPL')], ledger);

    assert.deepEqual(plan.actions, [
      { kind: 'sector', subject: 'utilities', enabled: false, entityId: 'entity-utilities' },
    ]);
  });

  it('keeps a sector on while any watched stock still sits in it', () => {
    const ledger = [row('company', 'AAPL'), row('company', 'MSFT'), row('sector', 'information_technology')];

    const plan = planDossierSync(
      [company('AAPL'), sector('information_technology')], ledger,
    );

    assert.deepEqual(plan.actions, [
      { kind: 'company', subject: 'MSFT', enabled: false, entityId: 'entity-msft' },
    ]);
  });

  it('does not confuse a ticker with a sector handle that reads the same', () => {
    const ledger = [row('sector', 'energy', { applied: true })];

    // A company called ENERGY is a different subject from sector:energy, and
    // the plan must not settle one against the other.
    const plan = planDossierSync([company('energy')], ledger);

    // The company is switched on and the sector switched off, independently —
    // if the key were the bare text, one would have settled against the other.
    assert.deepEqual(plan.actions, [
      { kind: 'company', subject: 'ENERGY', enabled: true,  entityId: null },
      { kind: 'sector',  subject: 'energy', enabled: false, entityId: 'entity-energy' },
    ]);
    assert.equal(plan.settled, 0);
  });

  it('retires a departed subject that was never switched on, rather than calling about it', () => {
    const ledger = [row('company', 'FOO', { applied: null, desired: false, state: 'pending' })];

    const plan = planDossierSync([], ledger);

    assert.deepEqual(plan.actions, [], 'nothing upstream to undo');
    assert.deepEqual(plan.retire, [{ kind: 'company', subject: 'FOO' }]);
  });

  it('leaves an ineligible entity alone — its type will not change because we asked twice', () => {
    const ledger = [row('company', 'BTC', { applied: null, state: 'ineligible', detail: 'type not a dossier subject' })];

    const plan = planDossierSync([company('BTC')], ledger);

    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.skipped, [{ subject: 'BTC', reason: 'type not a dossier subject' }]);
  });

  it('retries a subject Distill did not know, but only on a run — not on every save', () => {
    const ledger = [row('company', 'OBSCURE', { entityId: null, applied: null, state: 'unresolved', detail: 'no hit' })];

    const plan = planDossierSync([company('OBSCURE')], ledger);

    assert.deepEqual(plan.actions, [
      { kind: 'company', subject: 'OBSCURE', enabled: true, entityId: null },
    ]);
  });

  it('retries a switch that failed in transit', () => {
    const ledger = [row('company', 'AAPL', { applied: null, state: 'pending', detail: '503', attempts: 1 })];

    const plan = planDossierSync([company('AAPL')], ledger);

    assert.deepEqual(plan.actions, [
      { kind: 'company', subject: 'AAPL', enabled: true, entityId: 'entity-aapl' },
    ]);
  });

  it('normalises case per kind: tickers upper, handles lower', () => {
    const plan = planDossierSync(
      [company('aapl'), sector('Information_Technology')],
      [row('company', 'AAPL'), row('sector', 'information_technology')],
    );

    assert.deepEqual(plan.actions, []);
    assert.equal(plan.settled, 2);
  });
});

describe('classifyDossierFailure', () => {
  it('403 aborts the sync — the scope is a property of the key, not of the subject', () => {
    assert.equal(classifyDossierFailure(new DistillDossierScopeError(), 'entity-1').kind, 'abort');
  });

  it('401 aborts too, and keeps its own message', () => {
    const f = classifyDossierFailure(new DistillUnauthorizedError(), 'entity-1');
    assert.equal(f.kind, 'abort');
    assert.match((f as { error: Error }).error.message, /DISTILL_API_KEY/);
  });

  it('404 asks for a re-resolve rather than a repeat of the same call', () => {
    assert.equal(classifyDossierFailure(new DistillEntityGoneError('entity-1'), 'entity-1').kind, 're-resolve');
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
    assert.deepEqual(
      [
        classifyDossierFailure(new DistillDossierScopeError(), null).kind,
        classifyDossierFailure(new DistillEntityGoneError('e'), null).kind,
        classifyDossierFailure(new DistillDossierIneligibleError('e'), null).kind,
      ],
      ['abort', 're-resolve', 'record'],
    );
  });
});
