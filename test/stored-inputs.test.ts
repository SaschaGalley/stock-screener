/**
 * The inputs of one instant describe one moment.
 *
 * A refresh writes the financials and the market signals within seconds of
 * each other. When only the financials moved, the momentum pillar went on
 * reading the returns of whatever day the signals were last written — five
 * weeks earlier for six symbols on 22 September — beside that day's price.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_SIGNAL_LAG_MS, withinLag } from '../src/db/rescore.js';

describe('market readings beside the financials', () => {
  const anchor = new Date('2026-09-22T09:30:00Z');
  const at = (msBefore: number) => ({ data: 'signals', capturedAt: new Date(anchor.getTime() - msBefore) });

  it('keeps a reading from the same refresh, or from days before', () => {
    assert.equal(withinLag(at(500), anchor), 'signals');
    assert.equal(withinLag(at(MAX_SIGNAL_LAG_MS), anchor), 'signals');
  });

  it('drops one taken weeks before the financials it would be scored with', () => {
    assert.equal(withinLag(at(35 * 24 * 60 * 60 * 1000), anchor), null);
    assert.equal(withinLag(null, anchor), null);
  });
});
