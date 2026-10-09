/**
 * Reading a chart, on made-up prices: the swings, the levels they cluster
 * at, the channels, the volume's centre, open gaps and divergences.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chartAnalysis, regressionChannel, rsiSeries, smaSeries, volumeProfile, zigzag, type ChartBar,
} from '../src/analysis/chart.js';

/** Trading days from 2024-01-01 on, weekends skipped. */
function days(n: number): string[] {
  const out: string[] = [];
  const d = new Date('2024-01-01T00:00:00Z');
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Bars from closes: each opens at the last close and trades half a percent around its own. */
function bars(closes: number[], volume = (_k: number) => 1_000_000): ChartBar[] {
  const ds = days(closes.length);
  return closes.map((c, k) => ({
    day: ds[k], open: k > 0 ? closes[k - 1] : c, high: Math.max(c, k > 0 ? closes[k - 1] : c) * 1.005,
    low: Math.min(c, k > 0 ? closes[k - 1] : c) * 0.995, close: c, volume: volume(k),
  }));
}

/** A straight walk from `a` to `b` in `n` steps, `a` excluded. */
const walk = (a: number, b: number, n: number) => Array.from({ length: n }, (_, k) => a + ((b - a) * (k + 1)) / n);

describe('swings', () => {
  it('turns where the price reverses by several daily moves, and reads the trend from the turns', () => {
    const closes = [100, ...walk(100, 130, 20), ...walk(130, 112, 15), ...walk(112, 145, 20), ...walk(145, 124, 15), ...walk(124, 150, 20)];
    const b = bars(closes);
    const pivots = zigzag(b, b.map(() => 1.5));
    const confirmed = pivots.filter((p) => p.confirmed);
    assert.deepEqual(confirmed.map((p) => p.kind), ['low', 'high', 'low', 'high', 'low']);
    assert.ok(Math.abs(confirmed[1].price - 130 * 1.005) < 0.01);
    assert.ok(Math.abs(confirmed[2].price - 112 * 0.995) < 0.01);
    // The rise still running ends in a high not yet reversed.
    assert.equal(pivots.at(-1)!.kind, 'high');
    assert.equal(pivots.at(-1)!.confirmed, false);

    const a = chartAnalysis(b)!;
    assert.equal(a.structure.trend, 'up');
    assert.equal(a.structure.highs, 'higher');
    assert.equal(a.structure.lows, 'higher');
  });
});

describe('levels', () => {
  it('merges turns at the same price into one support, counted', () => {
    // Three falls to 100 from a range up to 120, and the price back at 115.
    const closes = [
      110, ...walk(110, 120, 10), ...walk(120, 100, 15), ...walk(100, 120, 15), ...walk(120, 100.4, 15),
      ...walk(100.4, 119, 15), ...walk(119, 99.8, 15), ...walk(99.8, 115, 12),
    ];
    const a = chartAnalysis(bars(closes))!;
    const support = a.levels.filter((l) => l.kind === 'support');
    const at100 = support.find((l) => Math.abs(l.price - 100) < 1.5)!;
    assert.ok(at100, 'a support near 100');
    assert.ok(at100.touches >= 3, `three turns at 100, got ${at100.touches}`);
    assert.ok(at100.distance < 0);
    const resistance = a.levels.filter((l) => l.kind === 'resistance');
    assert.ok(resistance.some((l) => Math.abs(l.price - 120) < 1.5), 'a resistance near 120');
    assert.ok(a.findings.some((f) => f.key === 'support'));
  });
});

describe('channels', () => {
  it('fits a straight path in log price, with its slope a year and an R² of one', () => {
    const closes = Array.from({ length: 300 }, (_, k) => 100 * Math.exp(0.001 * k));
    const c = regressionChannel(bars(closes), 252, '1 Jahr')!;
    assert.ok(Math.abs(c.slope - 0.252) < 1e-6);
    assert.ok(c.r2 > 0.999);
    assert.ok(Math.abs(c.center[1] - closes.at(-1)!) < 0.01);
  });

  it('puts a price that fell off a steady rise at the lower edge', () => {
    const closes = Array.from({ length: 120 }, (_, k) => 100 * Math.exp(0.002 * k) * (1 + 0.01 * Math.sin(k)));
    closes.push(closes.at(-1)! * 0.94);
    const c = regressionChannel(bars(closes), 63, '3 Monate')!;
    assert.ok(c.z < -2, `z ${c.z}`);
  });
});

describe('volume', () => {
  it('finds where most shares changed hands', () => {
    // Half a year around 50 on heavy volume, then a rise to 80 on light volume.
    const closes = [...Array.from({ length: 130 }, (_, k) => 50 + Math.sin(k / 3)), ...walk(50, 80, 120)];
    const p = volumeProfile(bars(closes, (k) => (k < 130 ? 5_000_000 : 500_000)))!;
    assert.ok(Math.abs(p.poc - 50) < 2, `POC ${p.poc}`);
    assert.ok(p.valueLow < 50 && p.valueHigh > 50);
  });

  it('declines when most bars carry no volume', () => {
    assert.equal(volumeProfile(bars(walk(10, 20, 120), (k) => (k % 2 ? 1 : 0)).map((b, k) => ({ ...b, volume: k % 3 ? null : b.volume }))), null);
  });
});

describe('gaps', () => {
  it('keeps a gap the price never went back into, and drops one it filled', () => {
    const closes = [...walk(100, 100.5, 80)];
    const b = bars(closes);
    // A gap up on day 70, never filled: everything after trades above 105.
    for (let k = 70; k < 80; k++) b[k] = { ...b[k], open: 106, high: 107, low: 105.5, close: 106.5 };
    // A gap up on day 40 that the next days fall back into.
    b[40] = { ...b[40], open: 103, high: 104, low: 102.8, close: 103.5 };
    const a = chartAnalysis(b)!;
    assert.equal(a.gaps.length, 1);
    assert.equal(a.gaps[0].day, b[70].day);
    assert.equal(a.gaps[0].dir, 'up');
    assert.ok(a.gaps[0].high === 105.5);
  });

  it('sees no gaps between bars that carry only a close', () => {
    const b = bars(walk(100, 150, 120)).map((x) => ({ ...x, open: null, high: null, low: null }));
    assert.deepEqual(chartAnalysis(b)!.gaps, []);
  });
});

describe('averages and momentum', () => {
  it('averages a window and says nothing before it is full', () => {
    assert.deepEqual(smaSeries([1, 2, 3, 4], 3), [null, null, 2, 3]);
  });

  it('reads RSI 100 on a straight rise and 0 on a straight fall', () => {
    assert.equal(rsiSeries(walk(1, 30, 30)).at(-1), 100);
    assert.equal(rsiSeries(walk(30, 1, 30)).at(-1), 0);
  });

  it('stacks the averages when the price has risen steadily', () => {
    const a = chartAnalysis(bars(Array.from({ length: 260 }, (_, k) => 50 + k * 0.2)))!;
    assert.equal(a.ma.stack, 'bull');
    assert.ok(a.findings.some((f) => f.key === 'ma' && f.tone === 'bull'));
  });

  it('declines to read fewer than sixty sessions', () => {
    assert.equal(chartAnalysis(bars(walk(1, 2, 59))), null);
  });
});

describe('the lean reading', () => {
  it('gives the stops and the trend the full reading gives', async () => {
    const { protectionOf } = await import('../src/analysis/stops.js');
    const { trendAnswer } = await import('../src/analysis/chart-reading.js');
    const closes = [100, ...walk(100, 130, 60), ...walk(130, 112, 40), ...walk(112, 145, 60), ...walk(145, 124, 50), ...walk(124, 150, 90)];
    const b = bars(closes, (k) => 1_000_000 + (k % 7) * 50_000);
    const full = chartAnalysis(b)!, lean = chartAnalysis(b, { lean: true })!;
    assert.deepEqual(protectionOf(b, lean), protectionOf(b, full));
    assert.deepEqual(trendAnswer(lean), trendAnswer(full));
    assert.deepEqual(lean.findings, []);
  });
});
