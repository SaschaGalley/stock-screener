/**
 * The models around the DCF that the same review touched: a dividend growth
 * rate that obeys the stable-growth cap, Piotroski's seventh signal, peer
 * multiples that vote once per fundamental, and the FCFF models stepping aside
 * for firms whose debt is their raw material.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  calculateCompositeFairValue, calculateDCF, calculateDDM, calculateEPV,
  calculatePeerMultiples, calculatePiotroski, calculateReverseDCF, CompositeInputs,
} from '../src/analysis/metrics.js';
import { FALLBACK_RATES } from '../src/data/fred.js';
import type { SectorMedians, StockFinancials } from '../src/types.js';

const rates = { ...FALLBACK_RATES, riskFreeRate: 0.0475, equityRiskPremium: 0.0409 };

function financials(over: Partial<StockFinancials> = {}): StockFinancials {
  return {
    price: 100,
    marketCap: 1_000_000_000,
    sharesOutstanding: 10_000_000,
    beta: 1,
    freeCashFlow: 50_000_000,
    ebit: 80_000_000,
    totalCash: 0,
    totalDebt: 0,
    interestExpense: null,
    taxRate: 0.21,
    earningsGrowth: 0.08,
    revenueGrowth: 0.08,
    dividendYield: null,
    dividendGrowthRate5Y: null,
    prevYear: null,
    fundamentalsHistory: {
      revenue: [], grossProfit: [], operatingIncome: [], netIncome: [], eps: [],
      freeCashFlow: [], operatingCashFlow: [], totalAssets: [], stockholdersEquity: [],
    },
    ...over,
  } as unknown as StockFinancials;
}

describe('dividend discount model', () => {
  it('caps perpetual dividend growth at the risk-free rate', () => {
    const ddm = calculateDDM(financials({ dividendYield: 0.03, dividendGrowthRate5Y: 0.08 }), rates);
    assert.equal(ddm.dividendGrowthRate, 0.0475);
  });

  it('assumes the cap when there is no growth figure, and never negative growth', () => {
    const none = calculateDDM(financials({ dividendYield: 0.03, earningsGrowth: null, revenueGrowth: null }), rates);
    const shrinking = calculateDDM(financials({ dividendYield: 0.03, dividendGrowthRate5Y: -0.02 }), rates);

    assert.equal(none.dividendGrowthRate, 0.0475);
    assert.equal(shrinking.dividendGrowthRate, 0);
  });
});

describe('Piotroski F7', () => {
  const withShares = (now: number | null, prev: number | null) => calculatePiotroski(financials({
    sharesOutstandingAnnual: now,
    prevYear: { sharesOutstanding: prev } as StockFinancials['prevYear'],
  }));

  it('scores a year without new shares', () => {
    assert.equal(withShares(95, 100).signals.f7_noNewShares, true);
    assert.equal(withShares(100, 100).signals.f7_noNewShares, true);
  });

  it('marks dilution', () => {
    assert.equal(withShares(105, 100).signals.f7_noNewShares, false);
  });

  it('stays unscored without both years', () => {
    assert.equal(withShares(null, 100).signals.f7_noNewShares, null);
    assert.equal(calculatePiotroski(financials()).signals.f7_noNewShares, null);
  });
});

describe('peer multiples', () => {
  it('gives each fundamental one vote, so revenue is not counted twice', () => {
    // Fair prices: P/E 80, EV/EBITDA 90, EV/Revenue 300, P/S 320, P/FCF 100, P/B 110.
    // Six values would put the median at 105; five fundamentals put it at 100.
    const f = financials({ eps: 4, ebitda: 300, revenue: 1000, freeCashFlow: 50, bookValue: 55, sharesOutstanding: 10 });
    const medians = { pe: 20, evToEbitda: 3, evToRevenue: 3, priceToSales: 3.2, priceToFCF: 20, pb: 2 } as SectorMedians;
    const peers = calculatePeerMultiples(f, medians);

    assert.equal(peers.count, 6);
    assert.equal(peers.medianFairPrice, 100);
  });
});

describe('banks, insurers and brokers', () => {
  const bank = financials({ industry: 'Banks - Regional' });

  it('leave the FCFF models, which say why', () => {
    const dcf = calculateDCF(bank, rates);
    const reverse = calculateReverseDCF(bank, rates);

    assert.equal(dcf.fairValue, null);
    assert.match(dcf.assumptions, /borrow as their business/);
    assert.equal(calculateEPV(bank, rates).fairValue, null);
    assert.equal(reverse.isPossible, false);
    assert.equal(reverse.impliedMargin, null);
  });

  it('show up in the composite as not applicable rather than as missing data', () => {
    const inputs = {
      dcf: calculateDCF(bank, rates),
      epv: calculateEPV(bank, rates),
      graham: { grahamNumber: null }, grahamRevised: { fairValue: null }, peterLynch: { fairValue: null },
      ddm: { isApplicable: false, fairValue: null }, rim: { fairValue: null, excessReturn: null },
      peerMultiples: { medianFairPrice: null }, beneish: { probability: 'unknown' },
    } as unknown as CompositeInputs;
    const reasons = new Map(calculateCompositeFairValue(bank, inputs).excludedModels.map((e) => [e.name, e.reason]));

    assert.match(reasons.get('DCF (2-Stage FCFF)') ?? '', /borrow as their business/);
    assert.match(reasons.get('EPV (Greenwald)') ?? '', /borrow as their business/);
  });

  it('do not take payment networks with them', () => {
    assert.notEqual(calculateDCF(financials({ industry: 'Credit Services' }), rates).fairValue, null);
  });
});
