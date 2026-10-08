/** The night watch on made-up closes. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newSignals, watchSignals, type WatchInput } from '../src/analysis/depot-watch.js';
import { watchAlert } from '../src/depot-watch-service.js';

const base: WatchInput = {
  close: 100, currency: 'USD', trailing: 95, stop: 90, score: 6, falling: false, reduceBelow: 5,
  price: (n, c) => `${n.toFixed(2)} ${c}`,
};

describe('the night watch', () => {
  it('signals nothing while the close holds and the score is fine', () => {
    assert.deepEqual(watchSignals(base), []);
  });

  it('signals a close under the trailing stop, the check\'s stop, and a weak score on a falling chart', () => {
    const s = watchSignals({ ...base, close: 89, score: 4.2, falling: true });
    assert.deepEqual(s.map((x) => x.kind), ['trailing', 'stop', 'reduce']);
    assert.match(s[0].text, /89\.00 USD unter dem Trailing-Stop bei 95\.00 USD/);
    assert.match(s[2].text, /Score 4,2 unter 5,0/);
  });

  it('wants both halves of the reduce signal', () => {
    assert.deepEqual(watchSignals({ ...base, score: 4.2 }).map((x) => x.kind), []);
  });

  it('announces a signal the night it appears, not every night it lasts', () => {
    assert.deepEqual(newSignals({ A: ['trailing'], B: ['stop', 'reduce'] }, { A: ['trailing'], B: ['stop'] }), { B: ['reduce'] });
    assert.deepEqual(newSignals({ A: ['trailing'] }, {}), { A: ['trailing'] });
  });

  it('says what is new in one message, and nothing when nothing is', () => {
    assert.equal(watchAlert([]), null);
    const a = watchAlert([{ symbol: 'MADE', name: 'Made Up', signal: watchSignals({ ...base, close: 94 })[0] }])!;
    assert.match(a.title, /1 Hinweis/);
    assert.match(a.text, /MADE · unter Trailing/);
  });
});
