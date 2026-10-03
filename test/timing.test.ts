/**
 * The timing readings on paths whose answer is known, and the study on a
 * market where the half deeper down is made to win.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Close } from '../src/analysis/evaluate.js';
import { BOUNCE, TIMING_CANDIDATES, TIMING_LOOKBACK, timingReadings } from '../src/analysis/timing.js';
import { timingStudy, type TimingRecord } from '../src/backtest/timing.js';

const path = (n: number, f: (k: number) => number) => Array.from({ length: n }, (_, k) => f(k));
const candidate = (key: string) => TIMING_CANDIDATES.find((c) => c.key === `timing.${key}`)!;

describe('timing readings', () => {
  it('need a year of closes', () => {
    assert.equal(timingReadings(path(TIMING_LOOKBACK - 1, () => 100)), null);
    assert.ok(timingReadings(path(TIMING_LOOKBACK, () => 100)));
  });

  it('read a steady climb as above its lines, overbought and in the middle of its channel', () => {
    const t = timingReadings(path(300, (k) => 100 * Math.exp(0.001 * k)))!;
    assert.ok(t.distSma50! > 0 && t.distSma200! > 0);
    assert.equal(t.rsi14, 100);
    assert.ok(Math.abs(t.channelSlope! - 0.252) < 1e-9);
    assert.equal(t.lowAgo, 125);
    assert.ok(Math.abs(t.m1 - (Math.exp(0.021) - 1)) < 1e-12);
  });

  it('place a close at the lower edge of a rising channel there', () => {
    // A zigzag around a rising line, ending a long way below it.
    const closes = path(300, (k) => 100 * Math.exp(0.001 * k + (k % 2 ? 0.01 : -0.01)));
    closes[closes.length - 1] *= Math.exp(-0.04);
    const t = timingReadings(closes)!;
    assert.ok(t.channelZ! < -2, `z ${t.channelZ}`);
    assert.ok(candidate('channel').read(t)! > 2);
  });

  it('call a fall and a rebound off the low a bounce, and a stock still falling not', () => {
    const fall = path(290, (k) => 200 - k * 0.5);
    const bounce = [...fall, ...path(8, (k) => fall[fall.length - 1] * (1 + 0.01 * (k + 1)))];
    const t = timingReadings(bounce)!;
    assert.equal(t.lowAgo, 8);
    assert.ok(t.fromLow126 >= BOUNCE.minRise);
    assert.equal(candidate('bounce').read(t), 1);
    assert.equal(candidate('bounce').read(timingReadings(fall)!), 0);
    assert.ok(candidate('support').read(timingReadings(fall)!) === 0, 'at the low');
  });
});

describe('the timing study', () => {
  const months = ['2019-01-31', '2019-02-28', '2019-03-29', '2019-04-30', '2020-01-31', '2020-02-28', '2020-03-31', '2020-04-30', '2020-05-29'];

  /** Forty stocks; those deeper down beat the rest by two percent a month, in every group. */
  function market() {
    const records: TimingRecord[] = [];
    const prices = new Map<string, Close[]>();
    for (let i = 0; i < 40; i++) {
      const symbol = `S${i}`;
      const deep = i % 2 === 0;
      let price = 100;
      const closes: Close[] = [];
      for (const day of months) {
        closes.push({ date: day, close: price });
        const readings = Float64Array.from(TIMING_CANDIDATES, () => (deep ? 1 + i / 100 : -1 - i / 100));
        records.push({ day, symbol, group: i < 14 ? 'buy' : i < 28 ? 'hold' : 'sell', readings });
        price *= deep ? 1.02 : 1;
      }
      prices.set(symbol, closes);
    }
    return { records, prices };
  }

  it('finds the dip paying, in every group and both halves', () => {
    const { records, prices } = market();
    const s = timingStudy(records, prices, months);
    const one = s.splits.filter((x) => x.horizon === 1);
    assert.equal(one.length, TIMING_CANDIDATES.length * 4);
    for (const x of one) {
      assert.ok(Math.abs(x.diff.mean! - 0.02) < 1e-9, `${x.candidate} ${x.group} ${x.diff.mean}`);
      assert.ok(x.first.mean! > 0 && x.second.mean! > 0);
    }
    assert.ok(Math.abs(s.groupShare.buy - 14 / 40) < 1e-12);
  });
});
