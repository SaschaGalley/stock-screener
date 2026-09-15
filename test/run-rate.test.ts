/**
 * Run-rate revenue: SVR, its seasonally adjusted twin, and the reverse SVR.
 *
 * The properties pinned here are the ones the numbers are only worth showing
 * for: steady growth cannot open a gap between SVR and its adjusted value, a
 * seasonal peak moves SVR but not the adjusted figure, the implied margin
 * inverts back to the margin a firm was priced at, and it still answers for a
 * firm burning cash, where the FCF-based reverse DCF cannot.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calculateDCF, calculateEVMultiples, calculateReverseDCF } from '../src/analysis/metrics.js';
import { runRateToTrailing, seasonallyAdjustedRunRate, SEASONAL_GAP_THRESHOLD } from '../src/analysis/run-rate.js';
import { FALLBACK_RATES, type MarketRates } from '../src/data/fred.js';
import type { StockFinancials } from '../src/types.js';

const rates: MarketRates = { ...FALLBACK_RATES, riskFreeRate: 0.04, aaaBondYield: 0.05, equityRiskPremium: 0.045 };

const QUARTER_ENDS = [
  '2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31',
  '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31',
];

/** Eight consecutive quarters growing steadily at `yoy`, times a seasonal pattern by position in the year. */
function quarters(latest: number, yoy: number, seasonal = [1, 1, 1, 1]) {
  const q = Math.pow(1 + yoy, 1 / 4);
  return QUARTER_ENDS.map((endDate, i) => ({
    endDate,
    revenue: latest * Math.pow(q, i - 7) * seasonal[i % 4],
  }));
}

/** A debt-free, cash-burning grower: 25M latest quarter, 30% YoY, 1B market cap. */
function financials(over: Partial<StockFinancials> = {}): StockFinancials {
  return {
    price: 100,
    marketCap: 1_000_000_000,
    sharesOutstanding: 10_000_000,
    enterpriseValue: 1_000_000_000,
    beta: 1,
    revenue: 90_000_000,
    revenueGrowth: 0.25,
    freeCashFlow: -20_000_000,
    ebitda: null,
    totalCash: 0,
    totalDebt: 0,
    interestExpense: null,
    taxRate: 0.21,
    epsGrowth3Y: null,
    earningsGrowth: null,
    earningsEstimates: [],
    quarterlyRevenues: quarters(25_000_000, 0.30),
    fundamentalsHistory: { freeCashFlow: [] },
    ...over,
  } as unknown as StockFinancials;
}

const close = (a: number | null | undefined, b: number, eps = 1e-9) =>
  assert.ok(a != null && Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

describe('run-rate factor', () => {
  it('is exactly latest quarter × 4 over TTM for steadily growing revenue', () => {
    const qs = quarters(25_000_000, 0.30);
    const ttm = qs.slice(-4).reduce((s, q) => s + q.revenue, 0);
    close(runRateToTrailing(0.30), (qs[7].revenue * 4) / ttm, 1e-12);
    assert.equal(runRateToTrailing(0), 1);
  });

  it('agrees with growing each quarter by its age, which is what we do with our own quarters', () => {
    const lastFour = quarters(25_000_000, 0.30).slice(-4).map((q) => q.revenue);
    const ttm = lastFour.reduce((s, r) => s + r, 0);
    close(seasonallyAdjustedRunRate(lastFour, 0.30), ttm * runRateToTrailing(0.30)!, 1e-6);
  });
});

describe('seasonally adjusted SVR', () => {
  it('equals SVR when revenue grows steadily', () => {
    const ev = calculateEVMultiples(financials());

    close(ev.simpleValuationRatio, 10);
    close(ev.seasonallyAdjustedValuationRatio, 10);
    close(ev.seasonalGap, 0);
    close(ev.latestQuarterYoYGrowth, 0.30);
  });

  it('does not care which quarter of the year the seasonal peak falls in', () => {
    const peakLatest = calculateEVMultiples(financials({ quarterlyRevenues: quarters(25_000_000, 0.30, [1, 1, 1, 1.4]) }));
    const peakEarlier = calculateEVMultiples(financials({ quarterlyRevenues: quarters(25_000_000, 0.30, [1.4, 1, 1, 1]) }));

    close(peakLatest.seasonallyAdjustedValuationRatio, peakEarlier.seasonallyAdjustedValuationRatio!);
    assert.ok(peakLatest.simpleValuationRatio! < peakEarlier.simpleValuationRatio!);
    assert.ok(peakLatest.seasonalGap! < -SEASONAL_GAP_THRESHOLD, `gap ${peakLatest.seasonalGap}`);
  });

  it('refuses a year-over-year comparison across a missing quarter', () => {
    const gappy = quarters(25_000_000, 0.30).filter((_, i) => i !== 5);
    const ev = calculateEVMultiples(financials({ quarterlyRevenues: gappy }));

    close(ev.simpleValuationRatio, 10);
    assert.equal(ev.seasonallyAdjustedValuationRatio, null);
    assert.equal(ev.latestQuarterYoYGrowth, null);
  });
});

describe('reverse SVR', () => {
  it('recovers the FCF margin a firm was priced at, even while it burns cash', () => {
    const margin = 0.2;
    const base = financials();
    const ev = calculateEVMultiples(base);
    const runRateRevenue = base.marketCap / ev.seasonallyAdjustedValuationRatio!;

    // Price the firm with the forward DCF at that margin on the same revenue path.
    const dcf = calculateDCF(
      { ...base, freeCashFlow: margin * runRateRevenue },
      rates,
      { growthRate: ev.latestQuarterYoYGrowth! },
    );
    const priced = financials({ price: dcf.fairValue!, marketCap: dcf.fairValue! * 10_000_000 });
    const reverse = calculateReverseDCF(priced, rates);

    assert.equal(reverse.isPossible, false);
    assert.equal(reverse.impliedMargin?.growthSource, 'latest quarter YoY');
    close(reverse.impliedMargin?.fcfMargin, margin);
    close(reverse.impliedMargin?.currentFcfMargin, -20 / 90);
  });

  it('prefers consensus revenue growth, capped like the DCF', () => {
    const estimate = (revenueGrowth: number) => financials({
      earningsEstimates: [{ period: '+1y', revenueGrowth }] as StockFinancials['earningsEstimates'],
    });

    const moderate = calculateReverseDCF(estimate(0.45), rates).impliedMargin;
    const extreme = calculateReverseDCF(estimate(0.90), rates).impliedMargin;

    assert.equal(moderate?.growthSource, 'analyst consensus');
    close(moderate?.revenueGrowth, 0.45);
    close(extreme?.revenueGrowth, 0.60);
  });

  it('has no answer without revenue', () => {
    const none = financials({ quarterlyRevenues: [], revenue: null });
    assert.equal(calculateReverseDCF(none, rates).impliedMargin, null);
  });
});
