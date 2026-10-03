/** A score's place among the universe's: the share below, ties counted half. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rankAmong } from '../src/utils/rank.js';

describe('rank among the universe', () => {
  const rank = rankAmong([5, 1, 3, 3, 9]);

  it('counts the share below, ties half', () => {
    assert.deepEqual(rank(3), { percentile: 0.4, of: 5 });
    assert.deepEqual(rank(10), { percentile: 1, of: 5 });
    assert.deepEqual(rank(0), { percentile: 0, of: 5 });
    assert.deepEqual(rank(6), { percentile: 0.8, of: 5 });
  });

  it('has nothing to say without a score or a universe', () => {
    assert.equal(rank(null), null);
    assert.equal(rankAmong([])(5), null);
  });
});
