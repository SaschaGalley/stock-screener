/**
 * Our verdicts as calls: a change counts once it holds, each call is measured
 * against the index from its own day, and a sell is right when the stock lags.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { callHit, callOutcomes, verdictCalls, verdictRecord } from '../src/analysis/verdict-record.js';
import { RECOMMENDATIONS } from '../src/verdict.js';

const day = (k: number) => new Date(Date.UTC(2025, 0, 1) + k * 86_400_000).toISOString().slice(0, 10);
const point = (k: number, verdict: string, score = 5) => ({ at: `${day(k)}T22:00:00Z`, verdict, score });

describe('verdicts as calls', () => {
  it('counts a change once it has held through the next reading', () => {
    const calls = verdictCalls([
      point(0, 'HOLD'), point(1, 'HOLD'),
      point(2, 'BUY'), point(3, 'HOLD'),          // a flicker: taken back the next day
      point(4, 'BUY'), point(5, 'BUY'),           // held
      point(6, 'SELL'),                           // the newest reading stands on its own
    ]);
    assert.deepEqual(calls.map((c) => [c.day, c.from, c.verdict]), [
      [day(0), null, 'HOLD'], [day(4), 'HOLD', 'BUY'], [day(6), 'BUY', 'SELL'],
    ]);
  });

  it('reads one verdict a day, the day\'s last', () => {
    const calls = verdictCalls([
      { at: `${day(0)}T08:00:00Z`, verdict: 'SELL', score: 3 },
      { at: `${day(0)}T22:00:00Z`, verdict: 'HOLD', score: 5 },
    ]);
    assert.deepEqual(calls.map((c) => c.verdict), ['HOLD']);
  });
});

describe('outcomes against the index', () => {
  // The stock rises 1 % a month faster than the index, over two years.
  const bars = Array.from({ length: 730 }, (_, k) => ({ day: day(k), close: 100 * 1.001 ** k }));
  const bench = Array.from({ length: 730 }, (_, k) => ({ day: day(k), close: 100 * 1.0007 ** k }));

  it('reads each horizon from the call\'s own day, and leaves the unfinished ones out', () => {
    const [buy, sell] = callOutcomes([
      { day: day(0), verdict: 'BUY', from: null, score: 7 },
      { day: day(500), verdict: 'SELL', from: 'BUY', score: 3 },
    ], bars, bench);
    assert.ok(buy.horizons[12]!.excess! > 0.1);
    assert.equal(buy.until, day(500));
    assert.equal(sell.until, null);
    assert.ok(sell.horizons[6]);
    assert.equal(sell.horizons[12], undefined);   // 500 + 365 is past the last bar
    assert.equal(callHit('BUY', buy.horizons[1]), true);
    assert.equal(callHit('SELL', sell.horizons[1]), false);
    assert.equal(callHit('HOLD', sell.horizons[1]), null);
  });

  it('adds the stocks up by verdict', () => {
    const outcomes = callOutcomes([{ day: day(0), verdict: 'BUY', from: null, score: 7 }], bars, bench);
    const r = verdictRecord(new Map([['X', outcomes], ['Y', outcomes]]), RECOMMENDATIONS);
    assert.equal(r.calls, 2);
    assert.equal(r.symbols, 2);
    assert.equal(r.byVerdict[0].verdict, 'BUY');
    assert.equal(r.byVerdict[0].horizons[3].hitRate, 1);
    assert.equal(r.directional[3].n, 2);
  });
});
