/**
 * Trailing figures rebuilt from the quarters.
 *
 * Yahoo's ready-made trailing fields turned out to mean something else — a
 * levered free cash flow, a one-quarter growth rate — so the figures are summed
 * from the quarterly statements instead. What these tests pin is the one thing a
 * sum of quarters can get wrong: counting across a hole.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { annualGrowth, consecutiveQuarters, trailingGrowth, trailingSum } from '../src/analysis/trailing.js';

const quarters = (values: number[], ends = ['2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30']) =>
  values.map((value, i) => ({ endDate: ends[ends.length - values.length + i], value }));

describe('trailing twelve months', () => {
  it('sums the last four quarters', () => {
    assert.equal(trailingSum(quarters([1, 2, 3, 4, 5])), 14);
  });

  it('refuses to sum across a missing quarter', () => {
    const gap = [
      { endDate: '2025-06-30', value: 1 }, { endDate: '2025-09-30', value: 1 },
      { endDate: '2026-03-31', value: 1 }, { endDate: '2026-06-30', value: 1 },
    ];
    assert.equal(consecutiveQuarters(gap, 4), null);
    assert.equal(trailingSum(gap), null, 'three quarters of time is not a year');
  });

  it('tolerates a 52/53-week calendar', () => {
    const shifted = [
      { endDate: '2025-06-28', value: 1 }, { endDate: '2025-09-27', value: 1 },
      { endDate: '2025-12-27', value: 1 }, { endDate: '2026-04-04', value: 1 },
    ];
    assert.equal(trailingSum(shifted), 4);
  });
});

describe('trailing growth', () => {
  it('compares four quarters with the four before them, not one with one', () => {
    // The latest quarter is up 60 % on its year-ago quarter; the year only 15 %.
    const q = quarters([10, 10, 10, 10, 10, 10, 10, 16]);
    assert.ok(Math.abs((trailingGrowth(q) as number) - 0.15) < 1e-12);
  });

  it('has no rate off a loss', () => {
    assert.equal(trailingGrowth(quarters([-5, -5, 2, 2, 5, 5, 5, 5])), null);
  });

  it('falls back to fiscal years with the same guard', () => {
    assert.ok(Math.abs((annualGrowth([{ year: 2024, value: 100 }, { year: 2025, value: 106.4 }]) as number) - 0.064) < 1e-12);
    assert.equal(annualGrowth([{ year: 2024, value: -3 }, { year: 2025, value: 5 }]), null);
  });
});
