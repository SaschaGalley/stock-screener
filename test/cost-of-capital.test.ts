/**
 * What the models discount with, and what they let a firm grow to.
 *
 * The premium is the market's own number plus the country's, betas regress
 * towards one, debt costs what the firm's rating would cost today, stable
 * growth never outruns either the economy or the firm, and the forward and the
 * reverse DCF price the same firm the same way.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  premiumFor, premiumGroups, premiumTable, PREMIUM_GROUP_MIN, useCalibrationTable, usePremiumAdjustment,
} from '../src/analysis/calibration.js';

import { calculateDCF, calculateReverseDCF, calculateRIM } from '../src/analysis/metrics.js';
import { adjustedBeta, betaPrior, costOfEquity, MATURE_MAX_DEBT_SHARE, wacc } from '../src/analysis/cost-of-capital.js';
import { valuationBasis } from '../src/analysis/basis.js';
import { baseFairValue, dcfInputs, MIN_TERMINAL_SPREAD } from '../src/analysis/dcf.js';
import { impliedPremiumShift, MIN_EQUITY_PREMIUM, modelRates } from '../src/analysis/computeMetrics.js';
import { FALLBACK_RATES, MarketRates } from '../src/data/fred.js';
import type { StockFinancials } from '../src/types.js';

// The explicit ramps, not whichever calibration is committed.
useCalibrationTable({});

const rates = (riskFreeRate: number, equityRiskPremium = 0.041): MarketRates =>
  ({ ...FALLBACK_RATES, riskFreeRate, equityRiskPremium });

/** A debt-free firm with a 20 % operating margin and consensus growth of 10 % then 8 %. */
function financials(over: Partial<StockFinancials> = {}): StockFinancials {
  return {
    price: 100,
    marketCap: 1_000_000_000,
    sharesOutstanding: 10_000_000,
    beta: 1,
    revenue: 500_000_000,
    ebit: 100_000_000,
    netIncome: 80_000_000,
    freeCashFlow: 60_000_000,
    totalCash: 0,
    totalDebt: 0,
    interestExpense: null,
    taxRate: 0.21,
    bookValue: 30,
    trailingSource: 'quarters',
    earningsEstimates: [
      { period: '0y', revenueGrowth: 0.10, epsGrowth: null, epsEstimate: null },
      { period: '+1y', revenueGrowth: 0.08, epsGrowth: null, epsEstimate: null },
    ],
    fundamentalsHistory: {
      revenue: [], grossProfit: [], operatingIncome: [], netIncome: [], eps: [],
      freeCashFlow: [], operatingCashFlow: [], totalAssets: [], stockholdersEquity: [],
    },
    ...over,
  } as unknown as StockFinancials;
}

const close = (a: number | null | undefined, b: number, eps = 1e-9) =>
  assert.ok(a != null && Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

describe('cost of equity', () => {
  it('discounts at the risk-free rate plus beta times the fetched premium', () => {
    const dcf = calculateDCF(financials(), rates(0.0475, 0.0409));
    assert.equal(dcf.equityRiskPremium, 0.0409);
    close(dcf.discountRate, 0.0475 + 0.0409, 1e-12);
  });

  it('pulls a regression beta a third of the way towards one', () => {
    close(adjustedBeta(2.2), 0.67 * 2.2 + 0.33, 1e-12);
    close(adjustedBeta(1), 1, 1e-12);
  });

  it('pulls it towards the peers\' beta instead, where there is a peer group', () => {
    close(adjustedBeta(1.1, 1.4), 0.67 * 1.1 + 0.33 * 1.4, 1e-12);
    assert.equal(adjustedBeta(null, 1.4), 1.4, 'no beta of its own: the bottom-up beta');
    assert.equal(betaPrior({ beta: 1.4 } as never), 1.4);
    assert.equal(betaPrior({ beta: null } as never), 1);
    assert.equal(betaPrior(null), 1);
  });

  it('discounts a stock in a high-beta industry at a higher rate than the same stock alone', () => {
    const alone = calculateDCF(financials({ beta: 1.1 }), rates(0.0475));
    const amongChipmakers = calculateDCF(financials({ beta: 1.1 }), rates(0.0475), { beta: 1.6 } as never);
    assert.ok(amongChipmakers.discountRate! > alone.discountRate!);
    close(amongChipmakers.beta, 0.67 * 1.1 + 0.33 * 1.6, 1e-12);
  });

  it('does not believe a listing that barely moves with the index', () => {
    // A European ADR against the S&P 500 read 0.28.
    assert.equal(adjustedBeta(0.28), 0.8);
  });

  it('adds the headquarters country\'s premium over the United States', () => {
    const us = costOfEquity(financials(), rates(0.0475, 0.041));
    const br = costOfEquity(financials({ countryRiskPremium: 0.03 }), rates(0.0475, 0.041));
    close(br - us, 0.03, 1e-12);
  });

  it('falls back to the shared constants when no rates were fetched', () => {
    const dcf = calculateDCF(financials(), FALLBACK_RATES);
    assert.equal(dcf.equityRiskPremium, FALLBACK_RATES.equityRiskPremium);
    assert.equal(dcf.riskFreeRate, FALLBACK_RATES.riskFreeRate);
  });
});

describe('cost of debt', () => {
  it('prices debt at the spread its interest coverage earns, not at its old coupon', () => {
    // Coverage 110 / 40 = 2.75 → BBB.
    const dcf = calculateDCF(
      financials({ totalDebt: 500_000_000, interestExpense: 40_000_000, ebit: 110_000_000 }),
      rates(0.0475, 0.0409),
    );
    assert.equal(dcf.syntheticRating, 'BBB');
    close(dcf.costOfDebt, 0.0475 + FALLBACK_RATES.creditSpreads.BBB, 1e-12);
    assert.match(dcf.assumptions, /Fremdkapital 5,9 % BBB/);
  });

  it('prices debt without reported interest as BBB, and says it did', () => {
    const dcf = calculateDCF(financials({ totalDebt: 500_000_000 }), rates(0.0475, 0.0409));
    assert.equal(dcf.syntheticRating, null);
    close(dcf.costOfDebt, 0.0475 + FALLBACK_RATES.creditSpreads.BBB, 1e-12);
    assert.match(dcf.assumptions, /ohne Rating → BBB/);
  });

  it('charges a borrower in a riskier country its government\'s default spread', () => {
    const f = financials({ totalDebt: 500_000_000, countryDefaultSpread: 0.02 });
    const dcf = calculateDCF(f, rates(0.0475, 0.0409));
    close(dcf.costOfDebt, 0.0475 + FALLBACK_RATES.creditSpreads.BBB + 0.02, 1e-12);
  });

  it('does not count US-GAAP operating leases as debt the cash flows are before', () => {
    const f = financials({ totalDebt: 300_000_000, leaseObligations: 100_000_000, operatingLeaseLiabilities: 120_000_000 });
    assert.equal(valuationBasis(f).debt, 200_000_000, 'only the leases that were in total debt come out');
  });
});

describe('terminal rate and growth', () => {
  it('holds a mature firm to a market-like capital structure', () => {
    // Half debt at a cheap after-tax rate pulled Fresenius Medical's terminal WACC
    // to 6.8 % against 5.2 % growth.
    const f = financials({ totalDebt: 1_000_000_000, interestExpense: 20_000_000 });
    const b = valuationBasis(f);
    const levered = wacc(f, b, rates(0.05), 1);
    const mature = wacc(f, b, rates(0.05), 1, MATURE_MAX_DEBT_SHARE);
    assert.ok(mature > levered, `${mature} > ${levered}`);
  });

  it('never grows faster than the economy, nor faster than the firm itself', () => {
    const fast = dcfInputs(financials(), rates(0.04), null);
    const slow = dcfInputs(financials({
      earningsEstimates: [
        { period: '0y', revenueGrowth: 0.03, epsGrowth: null, epsEstimate: null },
        { period: '+1y', revenueGrowth: 0.025, epsGrowth: null, epsEstimate: null },
      ] as StockFinancials['earningsEstimates'],
    }), rates(0.04), null);
    assert.ok('inputs' in fast && 'inputs' in slow);
    close(fast.inputs.assumptions.terminalGrowth, 0.04, 1e-12);
    close(slow.inputs.assumptions.terminalGrowth, 0.025, 1e-12);
  });

  it('does not let a shrinking year set a shrinking perpetuity', () => {
    const shrinking = dcfInputs(financials({
      earningsEstimates: [
        { period: '0y', revenueGrowth: -0.05, epsGrowth: null, epsEstimate: null },
        { period: '+1y', revenueGrowth: -0.02, epsGrowth: null, epsEstimate: null },
      ] as StockFinancials['earningsEstimates'],
    }), rates(0.04), null);
    assert.ok('inputs' in shrinking);
    close(shrinking.inputs.assumptions.terminalGrowth, 0.02, 1e-12);
    assert.equal(shrinking.inputs.assumptions.growth2, -0.02, 'the negative consensus is kept, not replaced by the past');
  });

  it('keeps stable growth two points below the terminal discount rate', () => {
    const built = dcfInputs(financials({ beta: 0.1 }), rates(0.06, 0.02), null);
    assert.ok('inputs' in built);
    const a = built.inputs.assumptions;
    assert.ok(a.terminalDiscountRate - a.terminalGrowth >= MIN_TERMINAL_SPREAD - 1e-12);
  });

  it('keeps no more excess return forever than the peers keep, and never less than the cost of capital', () => {
    const capped = calculateDCF(financials({ roic: 0.40 }), rates(0.0475), { roic: 0.15 } as never);
    close(capped.terminalRoic, 0.15, 1e-12);
    const floored = calculateDCF(financials({ roic: 0.03 }), rates(0.0475), null);
    close(floored.terminalRoic, floored.terminalDiscountRate!, 1e-12);
  });
});

describe('the revenue-driven DCF', () => {
  it('never reads this year\'s free cash flow', () => {
    // Microsoft's trailing "free cash flow" was 16.5 bn one day and 67 bn the next,
    // depending on which Yahoo field was read. The model builds its own.
    const a = calculateDCF(financials({ freeCashFlow: 10_000_000 }), rates(0.0475));
    const b = calculateDCF(financials({ freeCashFlow: 90_000_000 }), rates(0.0475));
    assert.equal(a.fairValue, b.fairValue);
  });

  it('answers with the same distribution every time', () => {
    const a = calculateDCF(financials(), rates(0.0475));
    const b = calculateDCF(financials(), rates(0.0475));
    assert.deepEqual(a.distribution, b.distribution);
    const d = a.distribution!;
    assert.ok(d.p10 <= d.p25 && d.p25 <= d.p50 && d.p50 <= d.p75 && d.p75 <= d.p90);
  });

  it('reads a higher price as less likely to be covered', () => {
    const cheap = calculateDCF(financials({ price: 50, marketCap: 500_000_000 }), rates(0.0475));
    const dear = calculateDCF(financials({ price: 400, marketCap: 4_000_000_000 }), rates(0.0475));
    assert.ok(cheap.distribution!.probabilityAbovePrice > dear.distribution!.probabilityAbovePrice);
  });

  it('abstains for a lender, whose debt is its inventory', () => {
    const dcf = calculateDCF(financials({ industry: 'Banks - Regional' }), rates(0.0475));
    assert.equal(dcf.fairValue, null);
    assert.match(dcf.assumptions, /Kreditgeber leihen sich Geld als Geschäft/);
  });
});

describe('reverse DCF', () => {
  it('recovers the growth and the margin the forward DCF priced', () => {
    const f = financials();
    const priced = calculateDCF(f, rates(0.0475, 0.0409));
    const atFair = { ...f, price: priced.fairValue!, marketCap: priced.fairValue! * 10_000_000 };
    const reverse = calculateReverseDCF(atFair, rates(0.0475, 0.0409));

    assert.ok(reverse.isPossible);
    // Growth held flat for two years reproduces the price somewhere between the
    // two consensus rates.
    assert.ok(reverse.impliedGrowthRate! > 0.07 && reverse.impliedGrowthRate! < 0.11, `${reverse.impliedGrowthRate}`);
    close(reverse.impliedMargin?.requiredMargin, priced.targetMargin!, 1e-4);
    close(reverse.discountRate, priced.discountRate!, 1e-12);
  });

  it('solves the margin the price requires even before there is a profit', () => {
    const f = financials({ ebit: -50_000_000 });
    const reverse = calculateReverseDCF(f, rates(0.0475));
    assert.equal(calculateDCF(f, rates(0.0475)).fairValue, null, 'no margin to converge to, no forward value');
    assert.ok(reverse.impliedMargin !== null && reverse.impliedMargin.requiredMargin > 0);
  });
});

describe('the model\'s premium', () => {
  it('adds the adjustment to the market\'s premium and records it', () => {
    const r = modelRates(financials(), rates(0.0475, 0.041), -0.015);
    close(r.equityRiskPremium, 0.026, 1e-12);
    close(r.premiumAdjustment, -0.015, 1e-12);
  });

  it('never discounts equities below a floor over the government bond', () => {
    const r = modelRates(financials(), rates(0.0475, 0.02), -0.015);
    assert.equal(r.equityRiskPremium, MIN_EQUITY_PREMIUM);
    close(r.premiumAdjustment, MIN_EQUITY_PREMIUM - 0.02, 1e-12);
  });

  it('finds the shift at which the DCF values a stock at its price', () => {
    const f = financials();
    const r = rates(0.0475, 0.041);
    const fair = baseFairValue(f, modelRates(f, r, 0))!;
    // Priced a fifth above the model: the market is discounting at a lower premium.
    const dear = { ...f, price: fair * 1.2, marketCap: fair * 1.2 * 10_000_000 } as typeof f;
    const shift = impliedPremiumShift({ financials: dear, rates: r, sectorMedians: null })!;
    assert.ok(shift < 0, `${shift}`);
    close(baseFairValue(dear, modelRates(dear, r, shift)), dear.price, dear.price * 1e-3);
  });

  it('puts a stock no shift can reach at the edge of the range instead of leaving it out', () => {
    const f = financials();
    const r = rates(0.0475, 0.041);
    const fair = baseFairValue(f, modelRates(f, r, 0))!;
    const absurd = { ...f, price: fair * 50, marketCap: fair * 50 * 10_000_000 } as typeof f;
    assert.equal(impliedPremiumShift({ financials: absurd, rates: r, sectorMedians: null }), -0.04);
  });

  it('measures a bank on the excess return model, which carries it, not on a DCF it has none of', () => {
    const bank = financials({ industry: 'Banks - Regional', normalizedNetIncome: 75_000_000, payoutRatio: 0.4 });
    const r = rates(0.0475, 0.041);
    const fair = calculateRIM(bank, modelRates(bank, r, 0)).fairValue!;
    const cheap = { ...bank, price: fair * 0.8, marketCap: fair * 0.8 * 10_000_000 } as typeof bank;
    const shift = impliedPremiumShift({ financials: cheap, rates: r, sectorMedians: null })!;
    assert.ok(shift > 0, `${shift}`);
    close(calculateRIM(cheap, modelRates(cheap, r, shift)).fairValue, cheap.price, cheap.price * 1e-3);
  });
});

describe('the premium by group', () => {
  it('reads a stock\'s premium from its narrowest group the table has', () => {
    const table = { 'USD|firm': -0.017, 'EUR|*': 0.013, '*|lender': 0.005, '*|*': -0.01 };
    assert.equal(premiumFor(table, 'USD', false), -0.017);
    assert.equal(premiumFor(table, 'USD', true), 0.005, 'no American lenders of their own: all lenders');
    assert.equal(premiumFor(table, 'EUR', true), 0.013, 'the currency before the kind');
    assert.equal(premiumFor(table, 'CHF', false), -0.01);
    assert.equal(premiumFor(table, null, true), 0.005);
    assert.equal(premiumFor({}, 'USD', false), 0);
    assert.deepEqual(premiumGroups('EUR', true), ['EUR|lender', 'EUR|*', '*|lender', '*|*']);
  });

  it('gives a group its own median only once it has enough stocks', () => {
    const points = [
      ...Array.from({ length: PREMIUM_GROUP_MIN }, (_, i) => ({ currency: 'USD', lender: false, shift: -0.02 + i * 1e-4 })),
      ...Array.from({ length: PREMIUM_GROUP_MIN - 1 }, () => ({ currency: 'EUR', lender: false, shift: 0.015 })),
      ...Array.from({ length: 5 }, () => ({ currency: 'EUR', lender: true, shift: 0.02 })),
    ];
    const { adjustments, groups } = premiumTable(points);
    assert.deepEqual(Object.keys(adjustments).sort(), ['*|*', '*|firm', 'EUR|*', 'USD|*', 'USD|firm']);
    close(adjustments['USD|firm'], -0.02 + 9.5e-4, 1e-12);
    assert.equal(adjustments['EUR|*'], 0.015, 'the euro lenders pool with the euro firms');
    assert.equal(groups['*|*'].stocks, 2 * PREMIUM_GROUP_MIN + 4);
  });

  it('prices each stock with its group\'s premium', () => {
    usePremiumAdjustment({ 'USD|firm': -0.017, 'EUR|*': 0.013 });
    try {
      close(modelRates(financials({ tradingCurrency: 'USD' }), rates(0.0475, 0.041)).equityRiskPremium, 0.041 - 0.017, 1e-12);
      // No currency on record, and no wider group in the table: no adjustment.
      close(modelRates(financials(), rates(0.0475, 0.041)).equityRiskPremium, 0.041, 1e-12);
      close(modelRates(financials({ tradingCurrency: 'EUR' }), rates(0.0475, 0.041)).equityRiskPremium, 0.041 + 0.013, 1e-12);
    } finally {
      useCalibrationTable({});
    }
  });
});
