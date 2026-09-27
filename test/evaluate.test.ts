/**
 * The evaluation has to be right about the one thing it exists for: crediting
 * a signal only with returns it could not have seen. A look-ahead bug here
 * would make any score look prescient, so these tests build markets where the
 * true answer is known by construction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { useCalibrationTable } from '../src/analysis/calibration.js';

import {
  evaluate, IC_PRIOR_SD, inCommonCurrency, MIN_CROSS_SECTION, ranks, sectorNeutralIc, spearman, suggestWeights,
  type Close, type IcSummary, type SignalPoint,
} from '../src/analysis/evaluate.js';

// The explicit ramps, not whichever calibration is committed.
useCalibrationTable({});

const DAYS = 40;
const day = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const flat: Close[] = Array.from({ length: DAYS }, (_, i) => ({ date: day(i), close: 100 }));

/** n stocks whose daily drift is `drift(k)`; one signal point per stock on day 0. */
function market(n: number, drift: (k: number) => number, score: (k: number) => number) {
  const prices = new Map<string, Close[]>();
  const points = new Map<string, SignalPoint[]>();
  for (let k = 0; k < n; k++) {
    const sym = `S${k}`;
    prices.set(sym, Array.from({ length: DAYS }, (_, i) => ({ date: day(i), close: 100 * (1 + drift(k)) ** i })));
    // Re-stated every day so no point goes stale over the test window.
    points.set(sym, Array.from({ length: DAYS }, (_, i) => ({ at: new Date(`${day(i)}T12:00:00Z`), value: score(k) })));
  }
  return { prices, points };
}

describe('rank correlation', () => {
  it('shares ranks between ties', () => {
    assert.deepEqual(ranks([3, 1, 3, 2]), [3.5, 1, 3.5, 2]);
  });
  it('is 1 for any monotone relationship and null for a constant', () => {
    assert.equal(spearman([1, 2, 3, 4], [1, 8, 27, 64]), 1);
    assert.equal(spearman([5, 5, 5], [1, 2, 3]), null);
  });
});

describe('evaluate', () => {
  it('finds a signal that ranks the drift perfectly', () => {
    const { prices, points } = market(12, (k) => k * 0.001, (k) => k);
    const ev = evaluate({ signals: new Map([['s', points]]), prices, benchmark: flat, horizons: [5] });
    const r = ev.ics[0];
    assert.ok(r.days > 0);
    assert.ok(Math.abs(r.meanIc! - 1) < 1e-9);
    assert.ok(r.spread! > 0);
  });

  it('finds nothing in a signal unrelated to the drift', () => {
    const { prices, points } = market(12, (k) => k * 0.001, (k) => (k * 7) % 12 === 0 ? 0 : (k * 7) % 12);
    const ev = evaluate({ signals: new Map([['s', points]]), prices, benchmark: flat, horizons: [5] });
    assert.ok(Math.abs(ev.ics[0].meanIc!) < 0.5);
  });

  it('never credits a signal with the return of the day it was observed', () => {
    // Every stock is flat except for one jump on day 20; the signal knows
    // about the jump only from day 20 on. A same-day read would score IC 1.
    const n = 12;
    const prices = new Map<string, Close[]>();
    const points = new Map<string, SignalPoint[]>();
    for (let k = 0; k < n; k++) {
      prices.set(`S${k}`, Array.from({ length: DAYS }, (_, i) => ({ date: day(i), close: i >= 20 ? 100 + k : 100 })));
      points.set(`S${k}`, [
        { at: new Date(`${day(0)}T12:00:00Z`), value: 0 },
        { at: new Date(`${day(19)}T23:00:00Z`), value: 0 },
        { at: new Date(`${day(20)}T12:00:00Z`), value: k },
      ]);
    }
    const ev = evaluate({ signals: new Map([['s', points]]), prices, benchmark: flat, horizons: [1] });
    // Day 20's window (close 20 → close 21) is flat for everyone, and the
    // window that contains the jump (19 → 20) sees only the constant zero.
    assert.equal(ev.ics[0].days, 0);
  });

  it('drops a series once it ends, but not across a gap inside it', () => {
    const { prices } = market(12, (k) => k * 0.001, () => 0);
    const points = new Map<string, SignalPoint[]>();
    for (let k = 0; k < 12; k++) points.set(`S${k}`, [{ at: new Date(`${day(0)}T12:00:00Z`), value: k }]);
    const ev = evaluate({ signals: new Map([['s', points]]), prices, benchmark: flat, horizons: [1] });
    // Only days 1–10 are within reach of a single point written on day 0.
    assert.equal(ev.ics[0].days, 10);

    // The same point followed by one on day 30: days 1–29 all hold it.
    for (let k = 0; k < 12; k++) points.get(`S${k}`)!.push({ at: new Date(`${day(30)}T12:00:00Z`), value: k });
    const gapped = evaluate({ signals: new Map([['s', points]]), prices, benchmark: flat, horizons: [1] });
    assert.ok(gapped.ics[0].days >= 29);
  });

  it('reads nothing from a cross-section too thin to rank', () => {
    const { prices, points } = market(MIN_CROSS_SECTION - 1, (k) => k * 0.001, (k) => k);
    const ev = evaluate({ signals: new Map([['s', points]]), prices, benchmark: flat, horizons: [5] });
    assert.equal(ev.ics[0].days, 0);
    assert.equal(ev.ics[0].meanIc, null);
  });

  it('pools returns by verdict label', () => {
    const { prices, points } = market(12, (k) => (k < 6 ? -0.002 : 0.002), (k) => k);
    const labels = new Map<string, SignalPoint[]>();
    for (const [sym, pts] of points) {
      labels.set(sym, pts.map((p) => ({ at: p.at, value: null, text: p.value! < 6 ? 'SELL' : 'BUY' })));
    }
    const ev = evaluate({
      signals: new Map([['s', points], ['label', labels]]), prices, benchmark: flat, horizons: [5], labelKey: 'label',
    });
    const buy = ev.labels.find((l) => l.label === 'BUY')!;
    const sell = ev.labels.find((l) => l.label === 'SELL')!;
    assert.ok(buy.meanExcess! > 0 && sell.meanExcess! < 0);
    assert.ok(!ev.ics.some((r) => r.key === 'label'));
  });
});

describe('within sectors', () => {
  it('takes the industry bet out and keeps the stock picking', () => {
    // Two sectors. The one the signal likes fell as a whole, so across all
    // stocks the signal looks wrong — but inside each sector its order is the
    // order of the returns.
    const xs = [10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5];
    const ys = [-0.10, -0.09, -0.08, -0.07, -0.06, -0.05, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10];
    const sectors = [...Array(6).fill('A'), ...Array(6).fill('B')];
    assert.ok(spearman(xs, ys)! < 0, 'pooled, the sector bet dominates');
    // Not exactly 1: the demeaned returns tie across sectors only up to rounding.
    assert.ok(sectorNeutralIc(xs, ys, sectors)! > 0.98);
  });

  it('leaves out a sector of one, which has nothing to be ranked against', () => {
    const xs = Array.from({ length: 11 }, (_, i) => i);
    const ys = xs.map((x) => x * 0.01);
    const sectors = [...Array(10).fill('A'), 'lonely'];
    assert.equal(sectorNeutralIc(xs, ys, sectors), 1);
    assert.equal(sectorNeutralIc(xs.slice(0, 9), ys.slice(0, 9), sectors.slice(0, 9)), null, 'too few left to rank');
  });

  it('reports the sector-neutral IC beside the pooled one', () => {
    // The signal prefers the sector that falls, and within each sector the
    // stock that does best.
    const { prices, points } = market(
      12, (k) => (k % 2 ? 0.002 : -0.002) + k * 0.0001, (k) => (k % 2 ? 0 : 100) + k,
    );
    const sectors = new Map([...points.keys()].map((s, k) => [s, k % 2 ? 'up' : 'down']));
    const ev = evaluate({ signals: new Map([['s', points]]), prices, benchmark: flat, horizons: [5], sectors });
    assert.ok(ev.ics[0].neutralIc! > 0.98, `within each sector the drift follows k: ${ev.ics[0].neutralIc}`);
    assert.ok(ev.ics[0].meanIc! < 0, `pooled, the sector bet swamps it: ${ev.ics[0].meanIc}`);
  });
});

describe('in one currency', () => {
  it('credits a listing with its return in the benchmark\'s currency', () => {
    // Flat in euros while the euro gains 10 %: a dollar investor made 10 %.
    const eur: Close[] = [{ date: day(0), close: 100 }, { date: day(1), close: 100 }];
    const eurusd: Close[] = [{ date: day(0), close: 1.0 }, { date: day(1), close: 1.1 }];
    const usd = inCommonCurrency(eur, eurusd);
    assert.ok(Math.abs(usd[1].close / usd[0].close - 1.1) < 1e-12);
  });

  it('uses the last rate at or before a session, and drops sessions before the first', () => {
    const closes: Close[] = [{ date: day(0), close: 10 }, { date: day(2), close: 10 }, { date: day(5), close: 10 }];
    const fx: Close[] = [{ date: day(1), close: 2 }, { date: day(4), close: 3 }];
    assert.deepEqual(inCommonCurrency(closes, fx), [{ date: day(2), close: 20 }, { date: day(5), close: 30 }]);
  });
});

describe('weight suggestion', () => {
  const summary = (key: string, meanIc: number | null, se: number | null, independent = 12): IcSummary => ({
    key, horizon: 20, days: 100, independent, meanIc, se, tStat: null, neutralIc: null, neutralTStat: null,
    hitRate: null, spread: null, meanCrossSection: null,
  });
  const current = { a: 0.5, b: 0.3, c: 0.2 };
  const keyOf = (p: string) => p;

  it('keeps the judgment where there is no evidence', () => {
    const w = suggestWeights(current, [summary('a', 0.2, null), summary('b', null, null)], 20, keyOf);
    assert.deepEqual(w.map((x) => x.suggested), [0.5, 0.3, 0.2]);
  });

  it('moves weight towards a pillar that ranked returns, less the less certain it is', () => {
    const strong = suggestWeights(current, [summary('c', 0.05, 0.005)], 20, keyOf);
    const noisy = suggestWeights(current, [summary('c', 0.05, 0.05)], 20, keyOf);
    const c = (w: typeof strong) => w.find((x) => x.key === 'c')!;
    assert.ok(c(strong).suggested > c(noisy).suggested && c(noisy).suggested > 0.2);
    assert.ok(Math.abs(c(noisy).shrunkIc - 0.025) < 1e-12, 'se equal to the prior halves the IC');
    for (const w of [strong, noisy]) {
      assert.ok(Math.abs(w.reduce((a, x) => a + x.suggested, 0) - 1) < 1e-12, 'the total is kept');
    }
  });

  it('drops a pillar measured at minus one prior width with certainty', () => {
    const w = suggestWeights(current, [summary('b', -IC_PRIOR_SD, 1e-6)], 20, keyOf);
    assert.ok(w.find((x) => x.key === 'b')!.suggested < 1e-6);
  });
});
