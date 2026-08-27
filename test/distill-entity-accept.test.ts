/**
 * When may a search hit be taken without a human looking at it?
 *
 * One answer for the whole codebase — company resolution and sector lookup use
 * the same function — so it is worth pinning tightly. The rule changed once
 * Distill began answering with its own `ambiguous` verdict: counting rows had
 * been rejecting perfectly good hits.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { acceptsAutomatically } from '../src/data/distill-entities.js';
import type { DistillEntityHit, DistillMatchTier, DistillSearchResult } from '../src/data/distill-entities.js';

function hit(matchedOn: DistillMatchTier, matchedValue = ''): DistillEntityHit {
  return {
    id: 'uuid-1', ref: 'company:x', type: 'company', handle: 'x',
    displayName: 'X', matchedOn, matchedValue,
    primarySymbol: null, country: null, sector: null, isin: null,
  };
}

const result = (over: Partial<DistillSearchResult> = {}): DistillSearchResult =>
  ({ hits: [], total: 1, ambiguous: false, ...over });

describe('acceptsAutomatically', () => {
  it('takes an id or ref match whatever else came back', () => {
    const noisy = result({ total: 9, ambiguous: true });
    assert.equal(acceptsAutomatically(hit('id'), noisy), true);
    assert.equal(acceptsAutomatically(hit('ref'), noisy), true);
  });

  it('never takes a name match, however clean the search looks', () => {
    assert.equal(acceptsAutomatically(hit('name'), result({ total: 1, ambiguous: false })), false);
  });

  it('takes a symbol match Distill calls unambiguous, even among several hits', () => {
    // The case that kept MOD and NU unresolved: two and five rows respectively,
    // with nothing actually competing against the symbol-tier hit.
    assert.equal(acceptsAutomatically(hit('symbol'), result({ total: 5, ambiguous: false })), true);
    assert.equal(acceptsAutomatically(hit('alias'),  result({ total: 2, ambiguous: false })), true);
  });

  it('refuses a symbol match Distill calls ambiguous, even as the only hit', () => {
    assert.equal(acceptsAutomatically(hit('symbol'), result({ total: 1, ambiguous: true })), false);
  });

  it('falls back to counting rows when Distill sends no verdict', () => {
    // An older deployment. One hit is takeable, more than one is not.
    assert.equal(acceptsAutomatically(hit('symbol'), result({ total: 1, ambiguous: undefined })), true);
    assert.equal(acceptsAutomatically(hit('symbol'), result({ total: 2, ambiguous: undefined })), false);
  });

  it('takes a globally unique key however ambiguous the rest looks', () => {
    const messy = result({ total: 4, ambiguous: true });
    assert.equal(acceptsAutomatically(hit('key', 'isin:US0378331005'), messy), true);
    assert.equal(acceptsAutomatically(hit('key', 'figi:BBG000B9XRY4'), messy), true);
    assert.equal(acceptsAutomatically(hit('key', 'lei:HWUPKR0MPOU8FGXBT394'), messy), true);
  });

  it('treats a ticker key like any other contested match', () => {
    assert.equal(acceptsAutomatically(hit('key', 'ticker:MOD'), result({ ambiguous: true })), false);
    assert.equal(acceptsAutomatically(hit('key', 'ticker:MOD'), result({ ambiguous: false })), true);
  });
});
