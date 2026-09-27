/**
 * The models around the DCF: a two-stage dividend model, Piotroski's fifth and
 * seventh signals, peer multiples that vote once per fundamental, Lynch's rule
 * kept inside its range, the excess return model standing in for the FCFF
 * models where debt is the raw material, and a composite no single model can
 * carry.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregateFairValue, beneishReading, calculateBeneish, calculateCompositeFairValue, calculateDCF, calculateDDM,
  calculateEPV, calculateInterestCoverage, calculatePeerMultiples, calculatePeterLynch, calculatePiotroski,
  calculateReverseDCF, calculateRIM, CompositeInputs, FAIR_VALUE_BOUNDS, LYNCH_MAX_GROWTH,
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
    revenue: 400_000_000,
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
  it('grows the dividend at its own rate for five years, then at no more than the economy', () => {
    const ddm = calculateDDM(financials({ dividendYield: 0.03, dividendGrowthRate5Y: 0.08 }), rates);
    assert.equal(ddm.dividendGrowthRate, 0.08);
    assert.equal(ddm.terminalGrowthRate, 0.0475);
  });

  it('never pays out a shrinking dividend for five years, nor a runaway one', () => {
    const shrinking = calculateDDM(financials({ dividendYield: 0.03, dividendGrowthRate5Y: -0.02 }), rates);
    const runaway = calculateDDM(financials({ dividendYield: 0.03, dividendGrowthRate5Y: 0.40 }), rates);
    assert.equal(shrinking.dividendGrowthRate, 0);
    assert.equal(runaway.dividendGrowthRate, 0.15);
  });

  it('is worth more for a faster-growing dividend', () => {
    const slow = calculateDDM(financials({ dividendYield: 0.03, dividendGrowthRate5Y: 0.02 }), rates);
    const fast = calculateDDM(financials({ dividendYield: 0.03, dividendGrowthRate5Y: 0.10 }), rates);
    assert.ok(fast.fairValue! > slow.fairValue!);
  });
});

describe('Piotroski', () => {
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

  it('does not fail a balance sheet that had no debt to reduce', () => {
    const debtFree = calculatePiotroski(financials({
      longTermDebt: 0, totalAssets: 1000,
      prevYear: { longTermDebt: 0, totalAssets: 900 } as StockFinancials['prevYear'],
    }));
    assert.equal(debtFree.signals.f5_reducingLeverage, true);
  });
});

describe('peer multiples', () => {
  it('gives each fundamental one vote, so revenue is not counted twice', () => {
    // Fair prices: P/E 80, EV/EBITDA 90, EV/Revenue 300, P/S 320, P/FCF 100, P/B 110.
    // Six values would put the median at 105; five fundamentals put it at 100.
    const f = financials({
      eps: 4, ebitda: 300, revenue: 1000, freeCashFlow: 50, bookValue: 55, sharesOutstanding: 10,
      marketCap: 1000, trailingSource: 'quarters',
    });
    const medians = { pe: 20, evToEbitda: 3, evToRevenue: 3, priceToSales: 3.2, priceToFCF: 20, pb: 2, peerCount: 8 } as SectorMedians;
    const peers = calculatePeerMultiples(f, medians);

    assert.equal(peers.count, 6);
    assert.equal(peers.medianFairPrice, 100);
  });

  it('prices a lender on earnings and book only', () => {
    const f = financials({
      eps: 4, ebitda: 300, revenue: 1000, freeCashFlow: 50, bookValue: 55, sharesOutstanding: 10,
      marketCap: 1000, trailingSource: 'quarters', industry: 'Banks - Regional',
    });
    const medians = { pe: 20, evToEbitda: 3, evToRevenue: 3, priceToSales: 3.2, priceToFCF: 20, pb: 2, peerCount: 8 } as SectorMedians;
    assert.deepEqual(calculatePeerMultiples(f, medians).byMultiple.map((e) => e.metric), ['pe', 'pb']);
  });
});

describe('Peter Lynch', () => {
  const withGrowth = (epsGrowth: number, eps0 = 5, eps1 = 6) => calculatePeterLynch(financials({
    netIncome: 60_000_000, dividendYield: 0,
    earningsEstimates: [
      { period: '0y', epsEstimate: eps0 }, { period: '+1y', epsEstimate: eps1, epsGrowth },
    ] as StockFinancials['earningsEstimates'],
  }));

  it('pays a P/E of the growth rate, and no more than 25', () => {
    // EPS 6 on 10M shares; 105 % consensus growth would have paid a P/E of 105.
    assert.equal(withGrowth(1.05).growthRate, LYNCH_MAX_GROWTH);
    assert.ok(Math.abs(withGrowth(1.05).fairValue! - 6 * 25) < 1e-9);
  });

  it('respects a consensus that expects earnings to fall', () => {
    // Novo Nordisk was grown at its 24 % history while the consensus said −3 %.
    const falling = calculatePeterLynch(financials({
      netIncome: 60_000_000, epsGrowth3Y: 0.24,
      earningsEstimates: [
        { period: '0y', epsEstimate: 5 }, { period: '+1y', epsEstimate: 4.85, epsGrowth: -0.03 },
      ] as StockFinancials['earningsEstimates'],
    }));
    assert.equal(falling.fairValue, null);
    assert.equal(falling.growthRate, -0.03);
  });

  it('never reads a quarter\'s jump', () => {
    const quarterly = calculatePeterLynch(financials({ netIncome: 60_000_000, earningsGrowth: 2.42, epsGrowth3Y: null }));
    assert.equal(quarterly.fairValue, null, 'Amazon was valued at 11.7× its price on a 242 % quarter');
  });
});

describe('Beneish and interest coverage', () => {
  it('compares a fiscal year with the one before, not the trailing year with it', () => {
    const f = financials({
      revenue: 2_400, grossProfit: 1_200, totalAssets: 5_000, receivables: 300, ppe: 1_000,
      totalCurrentAssets: 2_000, depreciation: 100, sga: 400, longTermDebt: 500, totalCurrentLiabilities: 800,
      operatingCashFlowAnnual: 500,
      fundamentalsHistory: {
        revenue: [{ year: 2024, value: 1_000 }, { year: 2025, value: 1_200 }],
        grossProfit: [{ year: 2024, value: 500 }, { year: 2025, value: 600 }],
        netIncome: [{ year: 2025, value: 300 }], operatingIncome: [], eps: [], freeCashFlow: [],
        operatingCashFlow: [], totalAssets: [], stockholdersEquity: [],
      },
      prevYear: {
        revenue: 1_000, grossProfit: 500, totalAssets: 4_500, receivables: 250, ppe: 900, currentAssets: 1_800,
        depreciation: 90, sga: 350, longTermDebt: 500, currentLiabilities: 700,
      } as StockFinancials['prevYear'],
    });
    assert.equal(calculateBeneish(f).sgi, 1.2, 'the trailing 2,400 would have read as 2.4');
  });

  it('gives one reading to everything that consumes the M-Score', () => {
    const b = { probability: 'likely manipulator', sgi: 1.8, tata: -0.05, variablesComputed: 8 } as ReturnType<typeof calculateBeneish>;
    assert.equal(beneishReading(financials(), b), 'growth-explained');
    assert.equal(beneishReading(financials(), { ...b, tata: 0.06 }), 'flagged');
  });

  it('does not score debt it cannot see the interest on as covered', () => {
    const apple = calculateInterestCoverage(financials({ totalDebt: 84_000_000_000, interestExpense: null }));
    assert.equal(apple.interpretation, 'unknown');
    const debtFree = calculateInterestCoverage(financials({ totalDebt: 0, interestExpense: null }));
    assert.equal(debtFree.interpretation, 'excellent');
  });
});

describe('banks, insurers and brokers', () => {
  const bank = financials({
    industry: 'Banks - Regional', bookValue: 50, trailingSource: 'quarters',
    normalizedNetIncome: 75_000_000, payoutRatio: 0.4,
  });

  it('leave the FCFF models, which say why', () => {
    const dcf = calculateDCF(bank, rates);
    const reverse = calculateReverseDCF(bank, rates);

    assert.equal(dcf.fairValue, null);
    assert.match(dcf.assumptions, /borrow as their business/);
    assert.equal(calculateEPV(bank, rates).fairValue, null);
    assert.equal(reverse.isPossible, false);
    assert.equal(reverse.impliedMargin, null);
  });

  it('are valued on book value and the return they earn on it', () => {
    // 15 % on equity against a cost of equity near 8.8 %: worth more than book,
    // and a bank earning its cost of equity exactly is worth its book.
    const rim = calculateRIM(bank, rates);
    assert.ok(rim.fairValue! > 50, `${rim.fairValue}`);
    const plain = calculateRIM({ ...bank, normalizedNetIncome: 44_000_000 }, rates);
    assert.ok(Math.abs(plain.fairValue! - 50) / 50 < 0.05, `${plain.fairValue}`);
  });

  it('show up in the composite with the excess return model in the headline tier', () => {
    const inputs = {
      dcf: calculateDCF(bank, rates),
      epv: calculateEPV(bank, rates),
      rim: calculateRIM(bank, rates),
      graham: { grahamNumber: null }, grahamRevised: { fairValue: null }, peterLynch: { fairValue: null },
      ddm: { isApplicable: false, fairValue: null },
      peerMultiples: { medianFairPrice: null, count: 0 }, beneish: { probability: 'unknown', variablesComputed: 0 },
    } as unknown as CompositeInputs;
    const composite = calculateCompositeFairValue(bank, inputs);
    const reasons = new Map(composite.excludedModels.map((e) => [e.name, e.reason]));

    assert.ok(composite.primary.models.some((m) => m.name === 'Excess Return (RIM)'));
    assert.match(reasons.get('EPV (Greenwald)') ?? '', /borrow as their business/);
  });

  it('do not take payment networks with them', () => {
    assert.notEqual(calculateDCF(financials({ industry: 'Credit Services' }), rates).fairValue, null);
  });
});

describe('the composite', () => {
  it('reports the models\' middle, but scores them within bounds', () => {
    // A DCF at five times the price next to a peer multiple at 1.2×: a median
    // of two is their mean, and it used to take the pair to +210 %.
    const models = [{ name: 'DCF', fairValue: 500, weight: 1 }, { name: 'Peers', fairValue: 120, weight: 1 }];
    const published = aggregateFairValue(100, models)!;
    const scored = aggregateFairValue(100, models, FAIR_VALUE_BOUNDS)!;
    assert.ok(Math.abs(published - Math.sqrt(500 * 120)) < 1e-9, 'geometric middle of two');
    assert.ok(Math.abs(scored - 100 * Math.sqrt(2.5 * 1.2)) < 1e-9, 'the outlier counts as 2.5×');
  });

  it('lets a fragile model count half', () => {
    const models = [{ name: 'DCF', fairValue: 40, weight: 0.5 }, { name: 'Peers', fairValue: 190, weight: 1 }];
    const scored = aggregateFairValue(100, models, FAIR_VALUE_BOUNDS)!;
    assert.ok(Math.abs(Math.log(scored / 100) - (0.5 * Math.log(0.4) + Math.log(1.9)) / 1.5) < 1e-9);
  });
});
