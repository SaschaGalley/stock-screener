/**
 * The review's list a page at a time: what each filter holds, the sort by how
 * a decision turned out, and the search. Invented decisions only.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { latestExcess, pageDecisions, type ReviewedDecision } from '../src/analysis/review.js';

const d = (key: string, day: string, side: 'buy' | 'sell', excess: number | null, extra: Partial<ReviewedDecision> = {}): ReviewedDecision => ({
  key, day, side, symbol: key.toUpperCase(), name: `${key.toUpperCase()} AG`, source: 'journal', entryId: null,
  reason: 'Weil die Marge steigt', tradeIds: [],
  outcome: excess === null ? null : { horizons: { 3: { stock: excess, index: 0, excess } }, since: null, due: {} },
  situation: null,
  ...extra,
});

const ds = [
  d('aaa', '2026-01-10', 'buy', 0.12),
  d('bbb', '2026-02-10', 'buy', -0.08, { reason: null }),
  d('ccc', '2026-03-10', 'sell', -0.05),
  d('ddd', '2026-04-10', 'sell', 0.2),
  d('eee', '2026-05-10', 'buy', null),
];

describe('the review, a page at a time', () => {
  it('counts every filter and pages the one chosen, newest first', () => {
    const p = pageDecisions(ds, { limit: 2 });
    assert.deepEqual(p.decisions.map((x) => x.key), ['eee', 'ddd']);
    assert.equal(p.next, 2);
    assert.equal(p.total, 5);
    assert.equal(p.counts.buy, 3);
    assert.equal(p.counts.unexplained, 1);
    // A sale is right when the stock lagged: ccc was, ddd was not.
    assert.equal(p.counts.right, 2);
    assert.equal(p.counts.wrong, 2);
  });

  it('sorts by how a decision turned out, either side, the unmeasured last', () => {
    assert.deepEqual(pageDecisions(ds, { sort: 'best' }).decisions.map((x) => x.key), ['aaa', 'ccc', 'bbb', 'ddd', 'eee']);
    assert.deepEqual(pageDecisions(ds, { sort: 'worst' }).decisions.map((x) => x.key), ['ddd', 'bbb', 'ccc', 'aaa', 'eee']);
  });

  it('searches ticker, name and reason, and the counts follow the search', () => {
    const p = pageDecisions(ds, { q: 'bbb' });
    assert.deepEqual(p.decisions.map((x) => x.key), ['bbb']);
    assert.equal(p.counts.all, 1);
    assert.equal(pageDecisions(ds, { q: 'marge', filter: 'sell' }).total, 2);
  });

  it('reads a decision by its longest measured horizon', () => {
    assert.equal(latestExcess(ds[0]), 0.12);
    assert.equal(latestExcess(ds[4]), null);
  });
});
