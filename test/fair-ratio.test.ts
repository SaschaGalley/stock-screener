/**
 * The fair multiple: a regression across the universe, read through one
 * stock's inputs — and the past-and-forecast years beside it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fairMultiple, fitFairRatio, type FairRatioRow } from '../src/analysis/fair-ratio.js';
import { growthPair, pastAndForecast } from '../src/analysis/forecast.js';

/** A universe where the multiple is exactly exp(1 + 2·growth + 1·margin), noise-free. */
function universe(n: number): FairRatioRow[] {
  return Array.from({ length: n }, (_, k) => {
    const g = -0.1 + (k % 20) * 0.03;
    const m = 0.05 + (Math.floor(k / 20) % 10) * 0.03;
    return {
      revenueGrowth: g, operatingMargin: m, grossMargin: 0.5, beta: 1,
      sector: k % 2 ? 'Technology' : 'Industrials',
      multiple: Math.exp(1 + 2 * g + m),
    };
  });
}

describe('the fair multiple', () => {
  it('recovers the relationship the universe follows', () => {
    const model = fitFairRatio(universe(200));
    assert.ok(model);
    assert.ok(model.r2 > 0.99, `R² ${model.r2}`);
    const fair = fairMultiple(model, { revenueGrowth: 0.2, operatingMargin: 0.2, grossMargin: 0.5, beta: 1, sector: 'Technology' })!;
    assert.ok(Math.abs(Math.log(fair) - (1 + 0.4 + 0.2)) < 0.02, `fair ${fair}`);
  });

  it('declines below sixty usable stocks, and ignores rows without a positive multiple', () => {
    assert.equal(fitFairRatio(universe(50)), null);
    const rows = universe(200).map((r, k) => (k < 150 ? { ...r, multiple: -3 } : r));
    assert.equal(fitFairRatio(rows), null);
  });

  it('says nothing when the inputs explain too little', () => {
    // Multiples unrelated to the inputs: the fit exists, the answer does not.
    const noise = universe(200).map((r, k) => ({ ...r, multiple: 5 + ((k * 7919) % 13) }));
    const model = fitFairRatio(noise)!;
    assert.ok(model.r2 < 0.2);
    assert.equal(fairMultiple(model, noise[0]), null);
  });
});

describe('past and forecast', () => {
  const input = {
    history: {
      revenue: [{ year: 2023, value: 100 }, { year: 2024, value: 110 }, { year: 2025, value: 121 }],
      eps: [{ year: 2023, value: 1 }, { year: 2024, value: 1.2 }, { year: 2025, value: 1.44 }],
    },
    estimates: [
      { period: '0q', endDate: '2026-03-31', epsEstimate: 0.4, epsLow: null, epsHigh: null, revenueEstimate: 32, numberOfAnalysts: 10 },
      { period: '0y', endDate: '2025-12-31', epsEstimate: 1.5, epsLow: 1.4, epsHigh: 1.6, revenueEstimate: 125, numberOfAnalysts: 10 },
      { period: '+1y', endDate: '2026-12-31', epsEstimate: 1.8, epsLow: 1.6, epsHigh: 2.0, revenueEstimate: 133.1, numberOfAnalysts: 9 },
    ],
  };

  it('appends only annual estimates for years not yet reported', () => {
    const rows = pastAndForecast(input);
    assert.deepEqual(rows.map((r) => `${r.year}${r.estimate ? 'e' : ''}`), ['2023', '2024', '2025', '2026e']);
    assert.equal(rows[3].epsHigh, 2.0);
  });

  it('compounds growth behind and ahead', () => {
    const g = growthPair(pastAndForecast(input), (r) => r.revenue);
    assert.ok(Math.abs(g.past! - 0.1) < 1e-9);
    assert.ok(Math.abs(g.ahead! - 0.1) < 1e-9);
    assert.equal(g.aheadYears, 1);
  });
});
