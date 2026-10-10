/**
 * Capital spending against depreciation, and the candidates the backtest
 * measures from it. The companies are made up.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { depreciationOutlook, INVESTMENT_CANDIDATES, type InvestmentHistory } from '../src/analysis/investment.js';
import type { StockFinancials } from '../src/types.js';

const series = (from: number, values: number[]) => values.map((value, i) => ({ year: from + i, value }));

/** A builder of data centres: spending tripling while depreciation lags behind it. */
const builder: InvestmentHistory = {
  revenue:         series(2022, [200, 210, 240, 280, 320]),
  operatingIncome: series(2022, [80, 85, 100, 115, 130]),
  totalAssets:     series(2022, [400, 420, 480, 560, 660]),
  capex:           series(2022, [25, 30, 50, 80, 120]),
  depreciation:    series(2022, [15, 17, 22, 30, 40]),
  grossPPE:        series(2022, [150, 180, 230, 310, 400]),
};

const candidate = (key: string, h: InvestmentHistory) =>
  INVESTMENT_CANDIDATES.find((c) => c.key === key)!.read({ fundamentalsHistory: h } as unknown as StockFinancials);

describe('the depreciation outlook', () => {
  it('reads a company spending three times its depreciation as a wave', () => {
    const o = depreciationOutlook(builder)!;
    assert.equal(o.level, 'wave');
    assert.equal(o.ratio, 3);
    assert.equal(o.firstRatio, 25 / 15);
    assert.equal(o.gap, 80);
    assert.equal(o.life, 10, 'gross PP&E over the year\'s depreciation');
    assert.equal(o.perYear, 8);
    assert.ok(Math.abs(o.perYearShare! - 8 / 130) < 1e-12);
    assert.equal(o.intensity, 120 / 320);
    assert.ok(o.depreciationGrowth! > o.operatingIncomeGrowth!);
  });

  it('calls spending about level with depreciation upkeep', () => {
    const o = depreciationOutlook({ ...builder, capex: series(2022, [16, 18, 23, 31, 44]) })!;
    assert.equal(o.level, 'none');
  });

  it('calls a high ratio on a small sum immaterial', () => {
    // A software company: spending five times depreciation, but a sliver of profit.
    const o = depreciationOutlook({ ...builder, capex: series(2022, [1, 1, 2, 3, 5]), depreciation: series(2022, [0.5, 0.5, 0.6, 0.8, 1]) })!;
    assert.equal(o.ratio, 5);
    assert.equal(o.level, 'none');
  });

  it('leaves the yearly step out where the balance sheet implies no believable life', () => {
    const o = depreciationOutlook({ ...builder, grossPPE: series(2026, [5000]) })!;
    assert.equal(o.life, null);
    assert.equal(o.perYear, null);
    assert.equal(o.level, 'wave');
  });

  it('has nothing to say without both lines', () => {
    assert.equal(depreciationOutlook({ ...builder, capex: undefined }), null);
    assert.equal(depreciationOutlook({ ...builder, depreciation: [] }), null);
  });
});

describe('the investment candidates', () => {
  it('reads spending over depreciation in the newest year', () => {
    assert.equal(candidate('investment.capex-to-depreciation', builder), 3);
  });

  it('reads abnormal investment against the three years before', () => {
    // 120/320 against the mean of 80/280, 50/240 and 30/210.
    const mean = (80 / 280 + 50 / 240 + 30 / 210) / 3;
    assert.ok(Math.abs(candidate('investment.abnormal-capex', builder)! - ((120 / 320) / mean - 1)) < 1e-12);
  });

  it('abstains on abnormal investment without four consecutive years', () => {
    const gappy = { ...builder, capex: [...series(2020, [10]), ...series(2024, [50, 80, 120])] };
    assert.equal(candidate('investment.abnormal-capex', gappy), null);
  });

  it('reads asset growth over the newest year', () => {
    assert.equal(candidate('investment.asset-growth', builder), 660 / 560 - 1);
  });
});
