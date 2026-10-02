/**
 * Reading today against the stock's own past: the statistics over a rebuilt
 * five-year series, and the margins over its fiscal years.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  discountRange, multipleStats, normalPE, type ValuationHistoryPoint,
} from '../src/analysis/valuation-history.js';
import { ratioSeries, summarise, trendTable } from '../src/analysis/trends.js';

const month = (k: number) => `20${21 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}-28`;
function series(n: number, f: (k: number) => Partial<ValuationHistoryPoint>): ValuationHistoryPoint[] {
  return Array.from({ length: n }, (_, k) => ({
    date: month(k), price: 100, fairValue: null, conservative: null, eps: null,
    pe: null, ps: null, pfcf: null, evEbitda: null, ...f(k),
  }));
}

describe('the gap to fair value over time', () => {
  it('gives the middle half of the months and where today sits in it', () => {
    // Fair value from 50 to 109 against a price of 100: margins −50 % … +9 %.
    const r = discountRange(series(60, (k) => ({ fairValue: 50 + k })));
    assert.ok(r);
    assert.ok(r.p25 < r.median && r.median < r.p75);
    assert.ok(Math.abs(r.latest - 0.09) < 1e-9);
    assert.equal(r.rank, 1, 'the cheapest month of all');
    assert.equal(r.months, 60);
  });

  it('says nothing below a year of months', () => {
    assert.equal(discountRange(series(11, () => ({ fairValue: 120 }))), null);
  });
});

describe('a multiple against its own past', () => {
  it('takes the median, so one year of near-zero earnings cannot set the norm', () => {
    // Two years at a P/E of 600, three at 40: the mean would be 264.
    const pts = series(60, (k) => ({ pe: k < 24 ? 600 : 40 }));
    const s = multipleStats(pts, 'pe');
    assert.equal(s.median5, 40);
    assert.equal(s.median3, 40);
    assert.equal(normalPE(pts), 40);
  });

  it('ignores losses rather than averaging them in as cheap', () => {
    const s = multipleStats(series(24, (k) => ({ pe: k % 2 ? -12 : 30 })), 'pe');
    assert.equal(s.median5, 30);
    assert.equal(s.months, 12);
  });

  it('ranks today and prices it at the usual multiple', () => {
    const pts = series(60, (k) => ({ ps: k === 59 ? 20 : 10 }));
    const s = multipleStats(pts, 'ps');
    assert.equal(s.latest, 20);
    assert.equal(s.rank, 1, 'dearer than every month before it');
    assert.equal(s.impliedPrice, 50, 'half the multiple, half the price');
  });

  it('has no today when the latest month has no reading', () => {
    const s = multipleStats(series(30, (k) => ({ evEbitda: k === 29 ? null : 15 })), 'evEbitda');
    assert.equal(s.latest, null);
    assert.equal(s.impliedPrice, null);
    assert.equal(s.median5, 15);
  });
});

describe('margins over the fiscal years', () => {
  const h = {
    revenue:            [{ year: 2022, value: 100 }, { year: 2023, value: 0 }, { year: 2024, value: 200 }],
    grossProfit:        [{ year: 2022, value: 40 }, { year: 2023, value: 10 }, { year: 2024, value: 100 }],
    operatingIncome:    [{ year: 2022, value: 10 }, { year: 2024, value: 40 }],
    netIncome:          [{ year: 2022, value: -5 }, { year: 2024, value: 30 }],
    freeCashFlow:       [{ year: 2022, value: 8 }, { year: 2024, value: 36 }],
    totalAssets:        [{ year: 2024, value: 300 }],
    stockholdersEquity: [{ year: 2024, value: -10 }],
  };

  it('leaves out a year whose denominator is zero or negative', () => {
    assert.deepEqual(ratioSeries(h, 'grossProfit', 'revenue').map((p) => p.year), [2022, 2024]);
    assert.deepEqual(ratioSeries(h, 'freeCashFlow', 'netIncome').map((p) => p.year), [2024], 'no conversion rate against a loss');
    assert.equal(ratioSeries(h, 'netIncome', 'stockholdersEquity').length, 0, 'no return on negative equity');
  });

  it('compares the latest year with the years before it', () => {
    const s = summarise([{ year: 2022, value: 0.2 }, { year: 2023, value: 0.3 }, { year: 2024, value: 0.4 }]);
    assert.ok(Math.abs(s.vsPrior! - 0.15) < 1e-9);
    assert.ok(Math.abs(s.avg3! - 0.3) < 1e-9);
    assert.equal(s.years, 3);
  });

  it('drops a ratio with no year at all', () => {
    assert.ok(!trendTable(h).some((r) => r.key === 'roe'));
    assert.ok(trendTable(h).some((r) => r.key === 'grossMargin'));
  });
});
