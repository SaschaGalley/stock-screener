/**
 * What the models discount with, and what they let a firm grow to.
 *
 * The premium is the market's own number, terminal growth is capped at the
 * risk-free rate and has to pay for itself, and debt costs what the firm's
 * rating would cost today. These tests pin those properties, plus the one that
 * keeps them honest: the forward and the reverse DCF price the same firm the
 * same way.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calculateDCF, calculateReverseDCF } from '../src/analysis/metrics.js';
import { FALLBACK_RATES, MarketRates } from '../src/data/fred.js';
import type { StockFinancials } from '../src/types.js';

const rates = (riskFreeRate: number, equityRiskPremium = 0.041): MarketRates =>
  ({ ...FALLBACK_RATES, riskFreeRate, equityRiskPremium });

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

const close = (a: number | null | undefined, b: number, eps = 1e-9) =>
  assert.ok(a != null && Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

describe('cost of capital', () => {
  it('discounts at the risk-free rate plus the fetched premium', () => {
    const dcf = calculateDCF(financials(), rates(0.0475, 0.0409));

    assert.equal(dcf.equityRiskPremium, 0.0409);
    close(dcf.discountRate, 0.0475 + 0.0409, 1e-12);
    assert.match(dcf.assumptions, /implied ERP 4\.1%/);
  });

  it('falls back to the shared constants when no rates were fetched', () => {
    const dcf = calculateDCF(financials());

    assert.equal(dcf.equityRiskPremium, FALLBACK_RATES.equityRiskPremium);
    assert.equal(dcf.riskFreeRate, FALLBACK_RATES.riskFreeRate);
  });

  it('prices debt at the spread its interest coverage earns, not at its old coupon', () => {
    // Coverage 110 / 40 = 2.75 → BBB. Interest ÷ debt would say 8% here — or,
    // for most real firms in 2026, less than the Treasury.
    const dcf = calculateDCF(
      financials({ totalDebt: 500_000_000, interestExpense: 40_000_000, ebit: 110_000_000 }),
      rates(0.0475, 0.0409),
    );

    assert.equal(dcf.syntheticRating, 'BBB');
    close(dcf.costOfDebt, 0.0475 + FALLBACK_RATES.creditSpreads.BBB, 1e-12);
    assert.match(dcf.assumptions, /kd 5\.9% BBB/);
  });

  it('prices debt without reported interest as BBB, and says it did', () => {
    const dcf = calculateDCF(financials({ totalDebt: 500_000_000 }), rates(0.0475, 0.0409));

    assert.equal(dcf.syntheticRating, null);
    close(dcf.costOfDebt, 0.0475 + FALLBACK_RATES.creditSpreads.BBB, 1e-12);
    assert.match(dcf.assumptions, /unrated → BBB/);
  });

  it('adds back after-tax interest only where operating cash flow paid it', () => {
    const at = (interestInOperatingCashFlow: boolean) => calculateDCF(
      financials({ interestExpense: 10_000_000, taxRate: 0.2, interestInOperatingCashFlow }),
      rates(0.0475),
      { growthRate: 0.1 },
    ).projectedFCFs[0];

    close(at(true), (50_000_000 + 8_000_000) * 1.1, 1e-3);
    close(at(false), 50_000_000 * 1.1, 1e-3);
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

  it('charges growth the reinvestment it needs', () => {
    // NOPAT 60 × 0.79 = 47.4 on FCFF 50; growth at 4.75% on a 20% ROIC costs
    // 23.75% of each year's operating profit.
    const f = financials({ ebit: 60_000_000, roic: 0.20 });
    const dcf = calculateDCF(f, rates(0.0475, 0.0409));
    const r = dcf.discountRate, g = dcf.terminalGrowthRate;
    const last = dcf.projectedFCFs[dcf.projectedFCFs.length - 1];

    close(dcf.terminalRoic, 0.20, 1e-12);
    close(dcf.terminalReinvestmentRate, g / 0.20, 1e-12);
    close(dcf.terminalValue, last * (47.4 / 50) * (1 + g) * (1 - g / 0.20) / (r - g), 1e-3);
  });

  it('keeps no more excess return forever than the peers keep', () => {
    const dcf = calculateDCF(financials({ ebit: 60_000_000, roic: 0.40 }), rates(0.0475), { sectorRoic: 0.15 });
    close(dcf.terminalRoic, 0.15, 1e-12);
  });

  it('never lets growth destroy value: terminal ROIC is floored at the discount rate', () => {
    const low = calculateDCF(financials({ ebit: 60_000_000, roic: 0.03 }), rates(0.0475, 0.0409));
    const none = calculateDCF(financials({ ebit: 60_000_000 }), rates(0.0475, 0.0409));

    close(low.terminalRoic, low.discountRate, 1e-12);
    close(none.terminalRoic, none.discountRate, 1e-12);
  });

  it('declines to value a firm whose discount rate has fallen to its growth rate', () => {
    // 95% debt that still rates AAA on coverage, at a 35% tax rate: the after-tax
    // cost of debt sits below the Treasury, and so does WACC. r ≤ g is not a low
    // valuation but a negative denominator, so the DCF drops out.
    const dcf = calculateDCF(
      financials({
        price: 10,
        marketCap: 100_000_000,
        totalDebt: 2_000_000_000,
        interestExpense: 1_000_000,
        ebit: 100_000_000,
        taxRate: 0.35,
      }),
      rates(0.0475, 0.0409),
    );

    assert.ok(dcf.discountRate < 0.0475, `WACC ${dcf.discountRate}`);
    assert.equal(dcf.fairValue, null);
    assert.match(dcf.assumptions, /not stable/);
  });
});

describe('reverse DCF', () => {
  it('recovers the stage-1 growth the forward DCF priced', () => {
    // A depressed trailing FCF the forward model lifts to its average, interest
    // it adds back, and a ROIC for the terminal value: the reverse solve used to
    // skip all three and discount at cost of equity instead of WACC.
    const f = financials({
      freeCashFlow: 30_000_000,
      fundamentalsHistory: { freeCashFlow: [{ year: 2023, value: 60e6 }, { year: 2024, value: 62e6 }, { year: 2025, value: 64e6 }] } as StockFinancials['fundamentalsHistory'],
      interestExpense: 8_000_000,
      ebit: 90_000_000,
      roic: 0.18,
    });
    const priced = calculateDCF(f, rates(0.0475, 0.0409), { growthRate: 0.12 });
    const reverse = calculateReverseDCF(
      { ...f, price: priced.fairValue!, marketCap: priced.fairValue! * 10_000_000 },
      rates(0.0475, 0.0409),
    );

    assert.ok(reverse.isPossible);
    close(reverse.impliedGrowthRate, 0.12, 1e-4);
    close(reverse.discountRate, priced.discountRate, 1e-12);
  });
});
