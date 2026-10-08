/**
 * Stops from a made-up chart: under which support the stop goes, where it
 * goes without one, and how far the chandelier trails the high.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChartAnalysis, ChartBar, PriceLevel } from '../src/analysis/chart.js';
import { protectionOf } from '../src/analysis/stops.js';

const close = 100;
const atr = 2;

const level = (price: number): PriceLevel => ({
  price, kind: price < close ? 'support' : 'resistance', touches: 2, firstDay: '2026-03-02', lastDay: '2026-08-14',
  flipped: false, source: 'swing', distance: price / close - 1, distanceAtr: (price - close) / atr, strength: 0.5,
});

/** A reading with only what the stops use filled in. */
const analysis = (levels: PriceLevel[]): ChartAnalysis => ({
  asOf: '2026-10-07', close, atr, pivots: [], levels, channels: [], trendlines: [], profile: null, fibonacci: null,
  structure: { trend: 'up', highs: 'higher', lows: 'higher', text: '' },
  ma: { sma20: 99, sma50: 96, sma200: 80, stack: 'bull', cross: null, sma200Slope: 0.01 },
  rsi14: 72, squeeze: null, divergences: [], breakouts: [], gaps: [], findings: [],
});

const bars: ChartBar[] = Array.from({ length: 30 }, (_, k) => ({
  day: `2026-09-${String(k + 1).padStart(2, '0')}`, open: 100, high: k === 20 ? 108 : 101, low: 99, close: 100, volume: 1,
}));

describe('the stop', () => {
  it('sits half a daily move under the nearest support out of the day\'s noise', () => {
    // 98 is one daily move down — noise; 94 is three; 90 is further.
    const p = protectionOf(bars, analysis([level(110), level(98), level(94), level(90)]), 'EUR');
    assert.equal(p.stop?.basis, 'support');
    assert.equal(p.stop?.level, 94);
    assert.equal(p.stop?.price, 93);
    assert.ok(Math.abs(p.stop!.distance - -0.07) < 1e-9);
    assert.ok(Math.abs(p.resistance! - 0.10) < 1e-9);
  });

  it('falls back to three daily moves under the close when no support is in reach', () => {
    // 98 is noise, 90 five daily moves down — too far for a stop.
    const p = protectionOf(bars, analysis([level(98), level(90), level(80)]));
    assert.equal(p.stop?.basis, 'atr');
    assert.equal(p.stop?.price, 94);
    assert.equal(p.stop?.level, null);
  });
});

describe('the trailing stop', () => {
  it('trails the 22-day high by three daily moves', () => {
    const p = protectionOf(bars, analysis([]));
    assert.equal(p.trailing?.high, 108);
    assert.equal(p.trailing?.price, 102);
    assert.ok(Math.abs(p.trailing!.width - 6 / 108) < 1e-9);
    assert.ok(Math.abs(p.trailing!.distance - 0.02) < 1e-9);
  });

  it('carries the readings beside the levels', () => {
    const p = protectionOf(bars, analysis([]));
    assert.equal(p.dailyMove, 0.02);
    assert.equal(p.rsi, 72);
    assert.ok(Math.abs(p.overSma200! - 0.25) < 1e-9);
    assert.equal(p.channel, null);
  });
});
