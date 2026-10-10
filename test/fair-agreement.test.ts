/**
 * How far the models agree on a fair value: the spread and its levels.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agreementOf, modelSpread } from '../src/analysis/fair-agreement.js';

describe('the models agreement', () => {
  it('reads the highest model less the lowest over the middle', () => {
    assert.equal(modelSpread({ min: 80, max: 120, median: 100 }), 0.4);
  });

  it('names the levels at a half and at one', () => {
    assert.equal(agreementOf(0.4)?.uncertainty, 'gering');
    assert.equal(agreementOf(0.5)?.uncertainty, 'mittel');
    assert.equal(agreementOf(0.99)?.answer, 'Teils uneins');
    assert.equal(agreementOf(1)?.uncertainty, 'hoch');
  });

  it('has no spread without a range or a positive middle', () => {
    assert.equal(modelSpread({ min: null, max: 120, median: 100 }), null);
    assert.equal(modelSpread({ min: 80, max: 120, median: 0 }), null);
    assert.equal(agreementOf(null), null);
  });
});
