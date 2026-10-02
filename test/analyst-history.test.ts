/**
 * The consensus of a past day, rebuilt from the rating actions: only what was
 * said before the day, each firm once, on today's share basis, and nothing
 * where too few firms were saying anything.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnalystAction } from '../src/analysis/analyst-accuracy.js';
import { consensusAt, firmWordsAt, MIN_CONSENSUS_FIRMS, ratingBucket, ratingDeltaAt } from '../src/analysis/analyst-history.js';

const action = (day: string, firm: string, toGrade: string | null, priceTarget: number | null): AnalystAction => ({
  gradedAt: `${day}T12:00:00Z`, firm, action: 'main', fromGrade: null, toGrade, priceTargetAction: null, priceTarget, priorPriceTarget: null,
});

describe('broker grades on the five-step scale', () => {
  it('reads each broker vocabulary', () => {
    const cases: [string, string | null][] = [
      ['Strong Buy', 'strongBuy'], ['Top Pick', 'strongBuy'], ['Buy', 'buy'], ['Outperform', 'buy'],
      ['Overweight', 'buy'], ['Market Outperform', 'buy'], ['Sector Outperform', 'buy'], ['Long-Term Buy', 'buy'],
      ['Positive', 'buy'], ['Neutral', 'hold'], ['Hold', 'hold'], ['Equal-Weight', 'hold'], ['Market Perform', 'hold'],
      ['Sector Weight', 'hold'], ['Peer Perform', 'hold'], ['Perform', 'hold'], ['In-Line', 'hold'],
      ['Underperform', 'sell'], ['Underweight', 'sell'], ['Reduce', 'sell'], ['Sell', 'sell'], ['Strong Sell', 'strongSell'],
      ['', null], ['Not Rated', null],
    ];
    for (const [grade, bucket] of cases) assert.equal(ratingBucket(grade), bucket, grade);
  });
});

describe('the consensus on a past day', () => {
  const actions = [
    action('2020-01-10', 'A', 'Buy', 100),
    action('2020-06-10', 'A', 'Hold', 90),          // A's newest
    action('2020-03-01', 'B', 'Outperform', 120),
    action('2020-05-01', 'C', 'Underweight', 60),
    action('2020-07-01', 'D', 'Buy', 200),          // on the day: not yet known
    action('2019-01-01', 'E', 'Buy', 500),          // older than a year
  ];

  it('takes each firm\'s newest word from the year before the day', () => {
    const c = consensusAt(actions, '2020-07-01');
    assert.equal(c.targetFirms, 3);
    assert.equal(c.targetMean, (90 + 120 + 60) / 3);
    assert.equal(c.targetMedian, 90);
    assert.equal(c.targetHigh, 120);
    assert.equal(c.targetLow, 60);
    assert.deepEqual(c.ratings, { strongBuy: 0, buy: 1, hold: 1, sell: 1, strongSell: 0 });
  });

  it('is silent below the minimum of firms', () => {
    const c = consensusAt(actions.slice(0, 3), '2020-07-01');
    assert.equal(c.targetFirms, MIN_CONSENSUS_FIRMS - 1);
    assert.equal(c.targetMean, null);
    assert.equal(c.ratings, null);
  });

  it('puts targets from before a split on today\'s basis', () => {
    const c = consensusAt(actions, '2020-07-01', [{ day: '2020-04-01', ratio: 2 }]);
    // A (June) and C (May) came after the split; B's March target halves.
    assert.equal(c.targetMean, (90 + 60 + 60) / 3);
  });

  it('counts the rating change against a month before', () => {
    const later = [...actions, action('2020-07-15', 'B', 'Neutral', 110)];
    const delta = ratingDeltaAt(later, '2020-08-01');
    // A month before (2 July): A hold, B buy, C sell, D buy. Now: B moved to hold.
    assert.deepEqual(delta, { strongBuy: 0, buy: -1, hold: 1, sell: 0, strongSell: 0 });
  });
});

describe('each firm\'s newest word', () => {
  it('keeps a firm\'s grade when its newest action only moved the target', () => {
    const words = firmWordsAt([
      action('2020-02-01', 'A', 'Overweight', 100),
      { ...action('2020-05-01', 'A', null, 120), priorPriceTarget: 100 },
    ], '2020-07-01');
    assert.equal(words.length, 1);
    assert.deepEqual(words[0].target, { day: '2020-05-01', value: 120, prior: 100 });
    assert.equal(words[0].grade?.label, 'Overweight');
    assert.equal(words[0].grade?.bucket, 'buy');
    assert.equal(words[0].grade?.day, '2020-02-01');
  });

  it('puts target and the one it replaced on today\'s share basis', () => {
    const [w] = firmWordsAt([{ ...action('2020-03-01', 'A', 'Buy', 400), priorPriceTarget: 300 }], '2020-07-01',
      [{ day: '2020-04-01', ratio: 4 }]);
    assert.deepEqual(w.target, { day: '2020-03-01', value: 100, prior: 75 });
  });

  it('leaves out a firm whose only word is older than the window or unreadable', () => {
    const words = firmWordsAt([
      action('2019-01-01', 'Old', 'Buy', 100),
      action('2020-03-01', 'Mute', 'Not Rated', null),
    ], '2020-07-01');
    assert.deepEqual(words, []);
  });
});
