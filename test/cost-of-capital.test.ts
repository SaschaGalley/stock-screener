/**
 * What the models discount with, and what they let a firm grow to.
 *
 * Both used to be constants sitting in `metrics.ts`. The premium is now the
 * market's own number and terminal growth is a rule about it, so these tests
 * pin the two properties that made the change worth making: the fetched
 * premium reaches the discount rate, and stable growth can never exceed the
 * risk-free rate no matter who asks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calculateDCF, calculateReverseDCF } from '../src/analysis/metrics.js';
import { FALLBACK_RATES, MarketRates } from '../src/data/fred.js';
import type { StockFinancials } from '../src/types.js';

const rates = (riskFreeRate: number, equityRiskPremium = 0.041): MarketRates =>
  ({ riskFreeRate, aaaBondYield: 0.05, equityRiskPremium });

/** A debt-free, β=1 firm — so cost of equity, WACC and CAPM all coincide. */
function financials(over: Partial<StockFinancials> = {}): StockFinancials {
  return {
    price: 100,
    marketCap: 1_000_000_000,
    sharesOutstanding: 10_000_000,
    beta: 1,
    freeCashFlow: 50_000_000,
    totalCash: 0,
    totalDebt: 0,
    interestExpense: null,
    taxRate: 0.21,
    forwardEpsGrowth: null,
    epsGrowth3Y: null,
    earningsGrowth: 0.08,
    revenueGrowth: 0.08,
    fundamentalsHistory: { freeCashFlow: [] },
    ...over,
  } as unknown as StockFinancials;
}

describe('cost of capital', () => {
  it('discounts at the risk-free rate plus the fetched premium', () => {
    const dcf = calculateDCF(financials(), rates(0.0475, 0.0409));

    assert.equal(dcf.equityRiskPremium, 0.0409);
    assert.ok(Math.abs(dcf.discountRate - (0.0475 + 0.0409)) < 1e-12);
    assert.match(dcf.assumptions, /implied ERP 4\.1%/);
  });

  it('falls back to the shared constants when no rates were fetched', () => {
    const dcf = calculateDCF(financials());

    assert.equal(dcf.equityRiskPremium, FALLBACK_RATES.equityRiskPremium);
    assert.equal(dcf.riskFreeRate, FALLBACK_RATES.riskFreeRate);
  });
});

describe('terminal growth', () => {
  it('defaults to the risk-free rate', () => {
    assert.equal(calculateDCF(financials(), rates(0.0475)).terminalGrowthRate, 0.0475);
    assert.equal(calculateReverseDCF(financials(), rates(0.0475)).terminalGrowthRate, 0.0475);
  });

  it('moves with the rate rather than sitting at a constant', () => {
    assert.equal(calculateDCF(financials(), rates(0.008)).terminalGrowthRate, 0.008);
  });

  it('clamps a caller who asks to grow faster than the economy', () => {
    const dcf = calculateDCF(financials(), rates(0.0475), { terminalGrowthRate: 0.06 });
    assert.equal(dcf.terminalGrowthRate, 0.0475);
  });

  it('leaves a more conservative request alone', () => {
    const dcf = calculateDCF(financials(), rates(0.0475), { terminalGrowthRate: 0.02 });
    assert.equal(dcf.terminalGrowthRate, 0.02);
  });

  it('declines to value a firm whose discount rate has fallen to its growth rate', () => {
    // A firm that is 95% debt discounts at an after-tax cost of debt that can
    // sit below the risk-free rate — and therefore below terminal growth now
    // that growth tracks that rate. r ≤ g is not a low valuation, it is a
    // negative denominator, so the DCF drops out instead of returning a number.
    const dcf = calculateDCF(
      financials({
        price: 10,
        marketCap: 100_000_000,
        totalDebt: 2_000_000_000,
        interestExpense: 1_000_000,   // ~0.05% — kd is floored at the risk-free rate
      }),
      rates(0.0475, 0.0409),
    );

    assert.ok(dcf.discountRate < 0.0475);
    assert.equal(dcf.fairValue, null);
    assert.match(dcf.assumptions, /not stable/);
  });
});
