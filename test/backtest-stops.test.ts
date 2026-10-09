/** A made-up position walked under the depot check's three exits. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PriceHistory } from '../src/backtest/prices.js';
import { walkPosition, type StopRecord } from '../src/backtest/stops.js';

// 40 quiet sessions at 100, then a climb to 120, a fall to 85 and a recovery to 110.
const path = [...Array(40).fill(100), 104, 108, 112, 116, 120, 112, 104, 96, 90, 85, 88, 92, 96, 100, 104, 108, 110];
const px: PriceHistory = {
  dates: path.map((_, k) => `2026-01-${String(k + 1).padStart(2, '0')}`), close: path, adj: path, splits: [],
  high: path.map((c) => c * 1.01), low: path.map((c) => c * 0.99),
};
const record = (over: Partial<StopRecord>): StopRecord => ({
  day: px.dates[39], symbol: 'MADE', i: 39, group: 'hold', score: 5, trend: 0, mom12: null, stop: null, width: null, ...over,
});
// A chandelier that only bites once the price has fallen well off its high.
const chandelier = Float64Array.from(path, (_, k) => (k >= 44 ? 100 : NaN));

describe('a position under the exits', () => {
  const w = walkPosition(record({ stop: 95, width: 0.1 }), px, chandelier, 17)!;

  it('holds to the end without a rule', () => {
    assert.ok(Math.abs(w.hold - 0.1) < 1e-9);
  });

  it('leaves at the first close at or under a fixed stop, and stays out', () => {
    assert.equal(w.out.stop!.left, 9);
    assert.ok(Math.abs(w.out.stop!.ret - -0.1) < 1e-9);
  });

  it('trails the highest close since the purchase by its width', () => {
    // 120 × 0.9 = 108: the close of 104 after the top is the first under it.
    assert.equal(w.out.trailing!.left, 7);
    assert.ok(Math.abs(w.out.trailing!.ret - 0.04) < 1e-9);
  });

  it('leaves when a close falls under the chandelier', () => {
    assert.equal(w.out.chandelier!.left, 8);
    assert.ok(Math.abs(w.out.chandelier!.ret - -0.04) < 1e-9);
  });

  it('walks only what the check could set, and nothing past the price history', () => {
    const bare = walkPosition(record({}), px, chandelier, 17)!;
    assert.equal(bare.out.stop, null);
    assert.equal(bare.out.trailing, null);
    assert.equal(walkPosition(record({}), px, chandelier, 30), null);
  });
});
