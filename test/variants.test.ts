/**
 * Bands moved by label: only the named boundaries move, the rest stay where
 * the published bands put them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verdictInBands } from '../src/backtest/variants.js';
import { verdictForScore } from '../src/verdict.js';

describe('verdicts in moved bands', () => {
  it('moves only the boundaries it names', () => {
    const bands = { BUY: 6, HOLD: 4 };
    assert.equal(verdictInBands(6.2, bands), 'BUY');
    assert.equal(verdictInBands(5.9, bands), 'HOLD');
    assert.equal(verdictInBands(3.9, bands), 'SELL');
    assert.equal(verdictInBands(8.1, bands), 'STRONG BUY');
    assert.equal(verdictInBands(1.9, bands), 'STRONG SELL');
  });

  it('is the published verdict without bands', () => {
    for (const s of [1, 2.5, 3.5, 5, 6.5, 7.9, 9]) assert.equal(verdictInBands(s, undefined), verdictForScore(s));
  });
});
