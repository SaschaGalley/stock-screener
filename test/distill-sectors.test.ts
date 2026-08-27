/**
 * Our sector vocabulary is Yahoo's, Distill's is a fixed list of twelve
 * handles. Nothing derives one from the other, so the translation table is
 * hand-written — which is exactly why it is worth pinning, and why the audit
 * that checks it against the live vocabulary is worth pinning too.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  auditSectorMapping,
  mappedHandles,
  sectorHandlesFor,
  sectorRef,
} from '../src/distill-sectors.js';

/** The twelve as the live project defines them, for the audit tests. */
const DISTILL_VOCABULARY = new Map(Object.entries({
  energy: 'Energy', materials: 'Materials', utilities: 'Utilities',
  financials: 'Financials', health_care: 'Health Care', industrials: 'Industrials',
  real_estate: 'Real Estate', consumer_staples: 'Consumer Staples',
  aerospace_defense: 'Aerospace & Defense', communication_services: 'Communication Services',
  consumer_discretionary: 'Consumer Discretionary', information_technology: 'Information Technology',
}));

describe('sectorHandlesFor', () => {
  it('translates a Yahoo sector to its Distill handle', () => {
    assert.deepEqual(sectorHandlesFor({ sector: 'Technology' }), ['information_technology']);
    assert.deepEqual(sectorHandlesFor({ sector: 'Consumer Cyclical' }), ['consumer_discretionary']);
    assert.deepEqual(sectorHandlesFor({ sector: 'Healthcare' }), ['health_care']);
  });

  it('is 1:n — Airbus is Industrials AND Aerospace & Defense', () => {
    // The case the mapping exists as a set for. `aerospace_defense` is a sector
    // in Distill but only ever an *industry* in ours, so it comes from the
    // industry field, in addition to the sector's own handle rather than
    // instead of it.
    assert.deepEqual(
      sectorHandlesFor({ sector: 'Industrials', industry: 'Aerospace & Defense' }),
      ['aerospace_defense', 'industrials'],
    );
  });

  it('ignores case and surrounding space, because profile data is not tidy', () => {
    assert.deepEqual(sectorHandlesFor({ sector: '  technology  ' }), ['information_technology']);
  });

  it('says nothing rather than guessing for an unknown sector', () => {
    assert.deepEqual(sectorHandlesFor({ sector: 'Miscellaneous' }), []);
    assert.deepEqual(sectorHandlesFor({ sector: null, industry: null }), []);
    assert.deepEqual(sectorHandlesFor({}), []);
  });

  it('takes the industry alone when the sector is missing', () => {
    assert.deepEqual(sectorHandlesFor({ industry: 'Aerospace & Defense' }), ['aerospace_defense']);
  });
});

describe('auditSectorMapping', () => {
  it('reaches every handle the live project defines', () => {
    const audit = auditSectorMapping(DISTILL_VOCABULARY);
    assert.deepEqual(audit.unknownTargets, [], 'our table points only at handles that exist');
    assert.deepEqual(audit.unreachable, [], 'all twelve are reachable from our classification');
  });

  it('names a handle we target that the project has dropped', () => {
    const shrunk = new Map(DISTILL_VOCABULARY);
    shrunk.delete('aerospace_defense');

    const audit = auditSectorMapping(shrunk);
    assert.deepEqual(audit.unknownTargets, ['aerospace_defense']);
  });

  it('names a thirteenth sector we cannot produce — the thing to report back', () => {
    const grown = new Map(DISTILL_VOCABULARY).set('quantum_computing', 'Quantum Computing');

    const audit = auditSectorMapping(grown);
    assert.deepEqual(audit.unreachable, ['quantum_computing']);
    assert.deepEqual(audit.unknownTargets, [], 'a new handle upstream is not a broken table');
  });
});

describe('sectorRef', () => {
  it('builds the ref form Distill accepts alongside the UUID', () => {
    assert.equal(sectorRef('information_technology'), 'sector:information_technology');
  });

  it('every mapped handle is one of the twelve', () => {
    for (const h of mappedHandles()) assert.ok(DISTILL_VOCABULARY.has(h), `${h} is not a Distill sector`);
  });
});
