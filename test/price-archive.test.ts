/**
 * Which stocks the daily archive fetches.
 *
 * The archive used to fill only as a stock was refreshed, so a stock nothing
 * refreshed — one that was only ever bought, never watched — had no prices,
 * and the journal and the review passed over it without a word.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pricesBehind } from '../src/history-service.js';

const STALE = '2026-09-30';
const INDEX = '2026-10-02';

describe('prices behind', () => {
  it('fetches a stock with nothing stored, refreshed nightly or not', () => {
    assert.deepEqual(pricesBehind([{ ticker: 'EXA', newest: null }], new Set(['EXA']), INDEX, STALE), ['EXA']);
    assert.deepEqual(pricesBehind([{ ticker: 'EXB', newest: null }], new Set(), INDEX, STALE), ['EXB']);
  });

  it('leaves a stock the nightly run refreshes to it until its refresh lapses', () => {
    const refreshed = new Set(['EXA']);
    assert.deepEqual(pricesBehind([{ ticker: 'EXA', newest: '2026-10-01' }], refreshed, INDEX, STALE), []);
    assert.deepEqual(pricesBehind([{ ticker: 'EXA', newest: '2026-09-29' }], refreshed, INDEX, STALE), ['EXA']);
  });

  it('keeps a stock nothing refreshes level with the index', () => {
    assert.deepEqual(pricesBehind([{ ticker: 'EXB', newest: '2026-10-01' }], new Set(), INDEX, STALE), ['EXB']);
    assert.deepEqual(pricesBehind([{ ticker: 'EXB', newest: INDEX }], new Set(), INDEX, STALE), []);
  });

  it('falls back to the lapse alone without an index', () => {
    assert.deepEqual(pricesBehind([{ ticker: 'EXB', newest: '2026-10-01' }], new Set(), null, STALE), []);
    assert.deepEqual(pricesBehind([{ ticker: 'EXB', newest: '2026-09-29' }], new Set(), null, STALE), ['EXB']);
  });
});
