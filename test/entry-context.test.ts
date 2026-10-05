/**
 * The situation on the day of a purchase or a sale: what had just happened to
 * the price and the volume, where it stood in its year, what our own model
 * said and whether a report was due. A flag is a fact, never a verdict.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { entryContext, type EntryBar } from '../src/analysis/entry-context.js';

/** Weekdays only, from `start`, with closes and volumes given per index. */
function bars(n: number, close: (i: number) => number, volume: (i: number) => number | null = () => 1e6): EntryBar[] {
  const out: EntryBar[] = [];
  const d = new Date('2025-06-02T12:00:00Z');
  for (let i = 0; out.length < n; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push({ day: d.toISOString().slice(0, 10), close: close(i), volume: volume(i) });
    i++;
  }
  return out;
}

describe('the situation before a purchase', () => {
  // A quiet year, gently wobbling, then a week of buying on heavy volume with one big day.
  const n = 300;
  const series = bars(n,
    (i) => (i < n - 5 ? 100 + Math.sin(i / 7) : 100 * (1 + 0.025 * (i - n + 6)) * (i >= n - 2 ? 1.08 : 1)),
    (i) => (i < n - 5 ? 1e6 : 3e6));
  const day = series[n - 1].day;

  it('names the run-up, the jump, the crowd, the high, the verdict and the report', () => {
    const c = entryContext('XYZ', 'buy', day, series, { score: 2.1, verdict: 'SELL' }, day);
    assert.equal(c.asOf, day);
    assert.ok(c.change5! > 0.1);
    assert.ok(c.volumeRatio! > 2.9 && c.volumeRatio! < 3.1);
    assert.equal(c.jumps.length, 1);
    assert.ok(c.jumps[0].change > 0.05);
    const text = c.flags.join(' | ');
    assert.match(text, /in den fünf Handelstagen davor/);
    assert.match(text, /Kurssprung \+/);
    assert.match(text, /Handelsvolumen 3,0-mal/);
    assert.match(text, /am Jahreshoch, \+2\d,\d % über dem Tief/);
    assert.match(text, /Modell-Urteil SELL \(Score 2,1\)/);
    assert.match(text, /Quartalszahlen am/);
  });

  it('reads the day as it was: an entry before the run-up sees none of it', () => {
    const c = entryContext('XYZ', 'buy', series[n - 10].day, series, { score: 4.5, verdict: 'BUY' }, null);
    assert.deepEqual(c.flags, []);
    assert.equal(c.jumps.length, 0);
  });

  it('says nothing about a buy signal when buying, or a rise when selling', () => {
    const c = entryContext('XYZ', 'sell', day, series, { score: 2.1, verdict: 'SELL' }, null);
    assert.doesNotMatch(c.flags.join(' | '), /Handelstagen|Kurssprung|Jahreshoch|Modell/);
    // Volume is a crowd either way.
    assert.match(c.flags.join(' | '), /Handelsvolumen/);
  });
});

describe('the situation before a sale', () => {
  const n = 300;
  const series = bars(n, (i) => (i < n - 5 ? 100 + Math.sin(i / 7) : 100 * (1 - 0.03 * (i - n + 6))));
  const day = series[n - 1].day;

  it('names the fall, the low and a model that still said buy', () => {
    const c = entryContext('XYZ', 'sell', day, series, { score: 4.6, verdict: 'BUY' }, null);
    const text = c.flags.join(' | ');
    assert.match(text, /−1\d,\d % in den fünf Handelstagen davor/);
    assert.match(text, /am Jahrestief, −1\d,\d % unter dem Hoch/);
    assert.match(text, /Modell-Urteil BUY/);
    assert.equal(c.volumeRatio, 1);
  });

  it('leaves the volume out when the history has none', () => {
    const c = entryContext('XYZ', 'sell', day, bars(n, () => 100, () => null), { score: null, verdict: null }, null);
    assert.equal(c.volumeRatio, null);
    assert.deepEqual(c.flags, []);
  });
});
