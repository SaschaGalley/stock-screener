/**
 * The evaluation has to be right about the one thing it exists for: crediting
 * a signal only with returns it could not have seen. A look-ahead bug here
 * would make any score look prescient, so these tests build markets where the
 * true answer is known by construction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluate, MIN_CROSS_SECTION, ranks, spearman, type Close, type SignalPoint } from '../src/analysis/evaluate.js';

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
