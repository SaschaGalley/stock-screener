/**
 * Trades walked on closes whose answer is known, and setups that fire where
 * the rule says.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BARRIERS, SETUPS, tradePlan, walkTrade } from '../src/analysis/setups.js';
import type { TimingReadings } from '../src/types.js';

const setup = (key: string) => SETUPS.find((s) => s.key === key)!;
const readings = (over: Partial<TimingReadings>): TimingReadings => ({
  m1: 0, rsi14: 50, distSma50: 0, distSma200: 0, channelZ: 0, channelSlope: 0,
  fromLow126: 0.3, lowAgo: 60, atr14: 0.02, fromHigh252: -0.2, ...over,
});

describe('a trade on closes', () => {
  it('takes the target when a close reaches it first', () => {
    // 2 % a day from 100 with a 1 % typical move: the target at 103 is passed on day 2.
    const closes = [100, 102, 104.04, 106];
    assert.deepEqual(walkTrade(closes, 0, 0.01), { exit: 'target', ret: 104.04 / 100 - 1, sessions: 2 });
  });

  it('leaves at the close that gaps through the stop, at what it costs', () => {
    const t = walkTrade([100, 99.5, 90], 0, 0.01)!;
    assert.equal(t.exit, 'stop');
    assert.ok(Math.abs(t.ret + 0.1) < 1e-12);
  });

  it('runs out of time after the deadline, and says nothing when the closes end first', () => {
    const flat = Array.from({ length: BARRIERS.maxSessions + 1 }, () => 100);
    assert.deepEqual(walkTrade(flat, 0, 0.01), { exit: 'time', ret: 0, sessions: BARRIERS.maxSessions });
    assert.equal(walkTrade(flat.slice(0, 10), 0, 0.01), null);
  });

  it('puts the stop two typical moves down and the target three up', () => {
    const p = tradePlan(100, 0.02);
    assert.ok(Math.abs(p.stop - 96) < 1e-9 && Math.abs(p.target - 106) < 1e-9);
  });
});

describe('the setups', () => {
  it('fire on what their idea describes', () => {
    assert.equal(setup('dip-in-uptrend').fires({ t: readings({ distSma200: 0.05, rsi14: 30 }), fairGap: null }), true);
    assert.equal(setup('dip-in-uptrend').fires({ t: readings({ distSma200: -0.05, rsi14: 30 }), fairGap: null }), false);
    assert.equal(setup('undervalued-low-band').fires({ t: readings({ channelZ: -1.5 }), fairGap: Math.log(1.4) }), true);
    assert.equal(setup('undervalued-low-band').fires({ t: readings({ channelZ: -1.5 }), fairGap: null }), false);
    assert.equal(setup('new-high').fires({ t: readings({ fromHigh252: 0 }), fairGap: null }), true);
    assert.equal(setup('bounce').fires({ t: readings({ lowAgo: 8, fromLow126: 0.07 }), fairGap: null }), true);
  });
});
