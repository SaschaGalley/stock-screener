/**
 * The revenue consensus against its own past, from archived payloads. The
 * company and its estimates are made up.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { revenueRevisions, type EstimateSnapshot } from '../src/analysis/estimate-revisions.js';

/** A payload's estimates: this year's growth against the last reported year, next year's against this year's estimate. */
const snap = (at: string, g0: number, g1: number | null, end0 = '2027-06-30', end1 = '2028-06-30'): EstimateSnapshot => ({
  at: `${at}T02:00:00.000Z`,
  estimates: [
    { period: '0q', endDate: '2026-12-31', revenueGrowth: 0.5, numberOfAnalysts: 20 },
    { period: '0y', endDate: end0, revenueGrowth: g0, numberOfAnalysts: 30 },
    ...(g1 === null ? [] : [{ period: '+1y', endDate: end1, revenueGrowth: g1, numberOfAnalysts: 28 }]),
  ],
});

const close = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-12;

describe('the revenue revisions', () => {
  it('reads this year\'s revision from its growth against a fixed base', () => {
    const r = revenueRevisions([snap('2026-06-01', 0.10, 0.08), snap('2026-09-01', 0.10, 0.08), snap('2026-10-01', 0.122, 0.08)], '2026-10-10')!;
    const y0 = r.find((y) => y.period === '0y')!;
    assert.ok(close(y0.sinceChange, 1.122 / 1.10 - 1));
    assert.ok(close(y0.d30, 1.122 / 1.10 - 1), 'the raise came within the last 30 days');
    assert.ok(close(y0.d90, 1.122 / 1.10 - 1));
    assert.equal(y0.since, '2026-06-01T02:00:00.000Z');
  });

  it('reads next year\'s level as both growths compounded', () => {
    // This year's estimate rises from 1.10 to 1.21 of the last reported year;
    // next year's growth falls just enough that its revenue stays at 1.32.
    const g1 = 1.32 / 1.21 - 1;
    const r = revenueRevisions([snap('2026-06-01', 0.10, 0.20), snap('2026-10-01', 0.21, g1)], '2026-10-10')!;
    assert.ok(close(r.find((y) => y.period === '0y')!.sinceChange, 1.21 / 1.10 - 1));
    assert.ok(Math.abs(r.find((y) => y.period === '+1y')!.sinceChange) < 1e-12, 'next year\'s revenue did not move');
  });

  it('is blind to the currency the estimate was converted into', () => {
    // An ADR: the revenue estimate in dollars moved with the rate, the growth did not.
    const a = snap('2026-08-01', 0.05, 0.04), b = snap('2026-10-01', 0.05, 0.04);
    a.estimates = a.estimates.map((e) => ({ ...e, revenueEstimate: 100 }));
    b.estimates = b.estimates.map((e) => ({ ...e, revenueEstimate: 92 }));
    const r = revenueRevisions([a, b], '2026-10-10')!;
    assert.equal(r[0].sinceChange, 0);
  });

  it('leaves the windows the archive does not reach empty', () => {
    const r = revenueRevisions([snap('2026-09-20', 0.10, 0.08), snap('2026-10-05', 0.11, 0.08)], '2026-10-10')!;
    const y0 = r.find((y) => y.period === '0y')!;
    assert.equal(y0.d30, null);
    assert.equal(y0.d90, null);
    assert.ok(close(y0.sinceChange, 1.11 / 1.10 - 1));
  });

  it('measures a window against the consensus as it stood on that day', () => {
    // Raised in July, raised again in late September: 30 days back is the July level.
    const r = revenueRevisions([snap('2026-06-01', 0.10, null), snap('2026-07-15', 0.12, null), snap('2026-09-25', 0.13, null)], '2026-10-10')!;
    const y0 = r[0];
    assert.ok(close(y0.d30, 1.13 / 1.12 - 1));
    assert.ok(close(y0.d90, 1.13 / 1.10 - 1));
    assert.equal(y0.path.length, 3);
  });

  it('starts again when the fiscal year rolls over', () => {
    const r = revenueRevisions([
      snap('2026-05-01', 0.10, 0.08),
      snap('2026-08-01', 0.09, 0.07, '2027-06-30', '2028-06-30'),
      snap('2026-10-01', 0.095, 0.07, '2027-06-30', '2028-06-30'),
    ].map((s, k) => (k === 0 ? { ...s, estimates: s.estimates.map((e) => (e.period === '0y' ? { ...e, endDate: '2026-06-30' } : e.period === '+1y' ? { ...e, endDate: '2027-06-30' } : e)) } : s)), '2026-10-10')!;
    const y0 = r.find((y) => y.period === '0y')!;
    assert.equal(y0.endDate, '2027-06-30');
    assert.equal(y0.since, '2026-08-01T02:00:00.000Z', 'the year before the roll had another base');
  });

  it('ignores a repeat that differs only in the last float digit', () => {
    const r = revenueRevisions([snap('2026-08-01', 0.17879999, null), snap('2026-09-01', 0.1788, null), snap('2026-10-01', 0.17879999, null)], '2026-10-10')!;
    assert.equal(r[0].path.length, 1);
  });

  it('has nothing to say without this year\'s growth', () => {
    assert.equal(revenueRevisions([], '2026-10-10'), null);
    assert.equal(revenueRevisions([{ at: '2026-10-01T00:00:00Z', estimates: [{ period: '0y', endDate: '2027-06-30', revenueGrowth: null, numberOfAnalysts: null }] }], '2026-10-10'), null);
  });
});
