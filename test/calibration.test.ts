/**
 * Where a criterion is neutral.
 *
 * A criterion read against its reference distribution scores the typical stock
 * at 5 by construction. These tests pin the arithmetic that makes that true —
 * interpolation between percentiles, ties ranked at their middle, the explicit
 * ramp standing in until a distribution exists — and the criteria the review
 * rebuilt around it.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { calibrated, percentileIn, percentiles, useCalibrationTable } from '../src/analysis/calibration.js';
import { computeFactorScore } from '../src/analysis/score.js';
import { computeAllMetrics } from '../src/analysis/computeMetrics.js';
import { FALLBACK_RATES } from '../src/data/fred.js';
import type { MarketSignals, StockFinancials } from '../src/types.js';

afterEach(() => useCalibrationTable({}));

const close = (a: number | null | undefined, b: number, eps = 1e-9) =>
  assert.ok(a != null && Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

describe('percentiles', () => {
  const q = percentiles(Array.from({ length: 101 }, (_, i) => i));   // 0 … 100

  it('reads a value at its rank in the reference sample', () => {
    close(percentileIn(q, 50), 0.5);
    close(percentileIn(q, 25.5), 0.255);
    assert.equal(percentileIn(q, -1), 0);
    assert.equal(percentileIn(q, 101), 1);
  });

  it('ranks a tie at the middle of its run', () => {
    // A third "clean", two thirds something else: clean is neither the best nor
    // the worst reading of the three, it is the middle of where clean sits.
    const labels = percentiles([...Array(34).fill(0), ...Array(33).fill(0.5), ...Array(34).fill(1)]);
    const clean = percentileIn(labels, 1);
    assert.ok(clean > 0.8 && clean < 0.9, `${clean}`);
    close(percentileIn(labels, 0.5), 0.5, 0.02);
  });
});

describe('calibrated points', () => {
  const table = { 'x.y': { quantiles: percentiles(Array.from({ length: 101 }, (_, i) => i)), n: 101, symbols: 40 } };

  it('uses the distribution when there is one, flipped where less is better', () => {
    close(calibrated('x.y', 80, 1, () => null, { table }), 0.8);
    close(calibrated('x.y', 80, -1, () => null, { table }), 0.2);
  });

  it('falls back to the explicit ramp without one, or with too few stocks behind it', () => {
    assert.equal(calibrated('missing', 80, 1, () => 0.42, { table }), 0.42);
    const thin = { 'x.y': { ...table['x.y'], symbols: 3 } };
    assert.equal(calibrated('x.y', 80, 1, () => 0.42, { table: thin }), 0.42);
  });

  it('reads a figure within its sector where the sector is deep enough, else against the market', () => {
    const utilities = percentiles(Array.from({ length: 101 }, (_, i) => 2 + i * 0.04));   // 2 … 6
    const withSector = {
      'h.lev': { quantiles: percentiles(Array.from({ length: 101 }, (_, i) => i * 0.04)), n: 101, symbols: 200 },  // 0 … 4
      'h.lev@Utilities': { quantiles: utilities, n: 30, symbols: 30 },
      'h.lev@Energy': { quantiles: utilities, n: 5, symbols: 5 },
    };
    // 4× EBITDA is the worst of the market and the middle of the utilities.
    close(calibrated('h.lev', 4, -1, () => null, { table: withSector }), 0);
    close(calibrated('h.lev', 4, -1, () => null, { table: withSector, sector: 'Utilities' }), 0.5);
    close(calibrated('h.lev', 4, -1, () => null, { table: withSector, sector: 'Energy' }), 0, 1e-9);
  });

  it('abstains on a missing figure rather than calling it average', () => {
    assert.equal(calibrated('x.y', null, 1, () => 0.5, { table }), null);
  });
});

describe('criteria the review rebuilt', () => {
  const financials = {
    symbol: 'T', price: 100, marketCap: 1e9, sharesOutstanding: 1e7, earningsEstimates: [
      { period: '0y', numberOfAnalysts: 20 }, { period: '+1y', numberOfAnalysts: 20 },
    ],
    earningsSurprises: [], dataQualityWarnings: [], prevYear: null,
    fundamentalsHistory: { revenue: [], grossProfit: [], operatingIncome: [], netIncome: [], eps: [], freeCashFlow: [], operatingCashFlow: [], totalAssets: [], stockholdersEquity: [] },
  } as unknown as StockFinancials;
  const signals = (over: Record<string, unknown>) => ({
    technicals: { returns: { y1: 0.32, m1: 0.1 }, drawdownFromHighPct: -0.05, rsVsSector3M: 0 },
    revisions: {
      perPeriod: [
        { period: '0q', netRevision30d: 5 }, { period: '0y', netRevision30d: 6, epsChange30dPct: 0 },
        { period: '+1y', netRevision30d: 4 },
      ],
      analystRatingMoMDelta: null,
    },
    options: null, macro: {}, ...over,
  }) as unknown as MarketSignals;
  const criteria = (s: MarketSignals) => {
    const f = computeFactorScore({
      financials, metrics: computeAllMetrics(financials, FALLBACK_RATES, null),
      sectorMedians: null, marketSignals: s, technicalSignals: null,
    });
    return Object.fromEntries(f.pillars.flatMap((p) => p.criteria.map((c) => [c.key, c])));
  };

  it('reads momentum over twelve months, skipping the last one', () => {
    close(criteria(signals({}))['momentum-12-1'].value, 1.32 / 1.1 - 1);
  });

  it('counts revisions against the analysts who could have revised, once per year', () => {
    // 6 + 4 net over 20 + 20 analysts; the quarter's 5 is the same analysts again.
    close(criteria(signals({}))['revision-breadth'].value, 10 / 40);
  });
});
