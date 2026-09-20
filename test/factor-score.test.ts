/**
 * The properties the deterministic score has to keep, whatever the company.
 *
 * These are not "does AAPL score 7.4" tests — a threshold tweak should not
 * break a suite, and the number itself is only as good as the ramps behind it.
 * What is tested here is the structure the whole design rests on: that the
 * findings add up to the score, that missing data costs coverage instead of
 * silently voting average, that a flagged payload cannot produce a confident
 * verdict, and that two runs over one payload agree.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analystConsensus, blendScores, computeFactorScore, PILLAR_WEIGHTS } from '../src/analysis/score.js';
import { computeAllMetrics } from '../src/analysis/computeMetrics.js';
import { FALLBACK_RATES } from '../src/data/fred.js';
import type {
  DataQualityWarning, MarketSignals, SectorMedians, StockFinancials, TechnicalSignals,
} from '../src/types.js';

function financials(over: Partial<StockFinancials> = {}): StockFinancials {
  return {
    symbol: 'TEST',
    companyName: 'Test Corp',
    price: 100,
    marketCap: 1_000_000_000,
    sharesOutstanding: 10_000_000,
    beta: 1,
    eps: 6,
    revenue: 800_000_000,
    ebitda: 200_000_000,
    ebit: 160_000_000,
    freeCashFlow: 90_000_000,
    totalCash: 100_000_000,
    totalDebt: 150_000_000,
    interestExpense: 10_000_000,
    taxRate: 0.21,
    bookValue: 400_000_000,
    earningsGrowth: 0.10,
    revenueGrowth: 0.12,
    operatingMargin: 0.20,
    netMargin: 0.14,
    roic: 0.16,
    currentRatio: 1.8,
    dividendYield: null,
    dividendGrowthRate5Y: null,
    targetMeanPrice: 125,
    analystStrongBuy: 8,
    analystBuy: 6,
    analystHold: 3,
    analystSell: 1,
    analystStrongSell: 0,
    earningsSurprises: [
      { quarter: '2026Q1', epsEstimate: 1.4, epsActual: 1.5, surprisePct: 0.07 },
      { quarter: '2025Q4', epsEstimate: 1.3, epsActual: 1.25, surprisePct: -0.04 },
    ],
    earningsEstimates: [],
    dataQualityWarnings: [],
    prevYear: null,
    fundamentalsHistory: {
      revenue: [], grossProfit: [], operatingIncome: [], netIncome: [], eps: [],
      freeCashFlow: [], operatingCashFlow: [], totalAssets: [], stockholdersEquity: [],
    },
    ...over,
  } as unknown as StockFinancials;
}

const peers: SectorMedians = {
  pe: 22, evToEbitda: 12, evToRevenue: 3, priceToFCF: 25, priceToSales: 3.2,
  forwardPriceToSales: 3, runRatePriceToSales: 3.1, pb: 3,
  operatingMargin: 0.15, netMargin: 0.10, roe: 0.18, roic: 0.12,
  revenueGrowthYoY: 0.08, peerCount: 12, peers: [],
};

const technicals: TechnicalSignals = {
  movingAverages: { items: [], buy: 8, sell: 2, neutral: 2, score: 0.5, verdict: 'STRONG BUY' },
  oscillators:    { items: [], buy: 3, sell: 2, neutral: 2, score: 0.14, verdict: 'BUY' },
  overall:        { items: [], buy: 11, sell: 4, neutral: 4, score: 0.32, verdict: 'BUY' },
};

const signals = {
  technicals: {
    rsVsSPY3M: 0.06, rsVsSector3M: 0.02, position52WPct: 0.62,
    drawdownFromHighPct: -0.08, returns: { m1: 0.02, m3: 0.05, m6: 0.1, ytd: 0.12, y1: 0.2 },
  },
  revisions: {
    perPeriod: [
      { period: '0y', epsTrend: { current: 6.2, ago30d: 6.0 }, revisions: {}, netRevision30d: 3, epsChange30dPct: 0.033 },
      { period: '+1y', epsTrend: { current: 7.0, ago30d: 6.9 }, revisions: {}, netRevision30d: 2, epsChange30dPct: 0.014 },
    ],
    analystRatingMoMDelta: { strongBuy: 1, buy: 0, hold: 0, sell: 0, strongSell: 0 },
  },
  options: null,
  macro: {},
} as unknown as MarketSignals;

function score(over: Partial<StockFinancials> = {}, opts: {
  peers?: SectorMedians | null;
  signals?: MarketSignals | null;
  technicals?: TechnicalSignals | null;
} = {}) {
  const f = financials(over);
  const sectorMedians = opts.peers === undefined ? peers : opts.peers;
  return computeFactorScore({
    financials:       f,
    metrics:          computeAllMetrics(f, FALLBACK_RATES, sectorMedians),
    sectorMedians,
    marketSignals:    opts.signals === undefined ? signals : opts.signals,
    technicalSignals: opts.technicals === undefined ? technicals : opts.technicals,
  });
}

const ERROR_WARNING: DataQualityWarning = {
  code: 'STALE_TRAILING', severity: 'error', fields: ['revenue'],
  message: 'Trailing revenue sits 34% below the last full fiscal year.',
};

describe('factor score decomposition', () => {
  it('itemises exactly: the criterion impacts sum to raw − 5', () => {
    const s = score();
    const total = s.pillars
      .flatMap((p) => p.criteria)
      .reduce((sum, c) => sum + (c.impact ?? 0), 0);

    assert.ok(Math.abs(total - (s.raw - 5)) < 1e-9,
      `impacts summed to ${total}, raw − 5 is ${s.raw - 5}`);
  });

  it('spends the whole weight budget on the pillars that scored', () => {
    const s = score();
    const effective = s.pillars.reduce((sum, p) => sum + p.effectiveWeight, 0);
    assert.ok(Math.abs(effective - 1) < 1e-9);
  });

  it('is a pure function of its inputs', () => {
    assert.deepEqual(score(), score());
  });
});

describe('missing data', () => {
  it('drops an unscorable pillar and renormalises the rest, rather than scoring it 5', () => {
    const blind = score({}, { signals: null, technicals: null });
    const momentum = blind.pillars.find((p) => p.key === 'momentum');
    const valuation = blind.pillars.find((p) => p.key === 'valuation');

    assert.equal(momentum?.score, null);
    assert.equal(momentum?.effectiveWeight, 0);
    // Valuation's share grows because momentum and revisions left the table.
    assert.ok((valuation?.effectiveWeight ?? 0) > PILLAR_WEIGHTS.valuation);
    assert.ok(Math.abs(blind.pillars.reduce((s, p) => s + p.effectiveWeight, 0) - 1) < 1e-9);
  });

  it('charges the lost evidence to coverage, and coverage to confidence', () => {
    const full = score();
    const blind = score({}, { signals: null, technicals: null });

    assert.ok(blind.coverage < full.coverage);
    assert.ok(blind.confidence < full.confidence);
    // …and a lower confidence shrinks the score further toward neutral.
    assert.ok(blind.shrink < full.shrink);
  });

  it('reads a payload with nothing in it as neutral, not as a sell', () => {
    // A listed price and nothing else: no statements, no coverage, no history.
    const blank = financials({
      eps: null, revenue: null, ebitda: null, ebit: null, freeCashFlow: null,
      totalCash: null, totalDebt: null, interestExpense: null, bookValue: null,
      operatingMargin: null, netMargin: null, revenueGrowth: null, earningsGrowth: null,
      roic: null, currentRatio: null, earningsSurprises: [],
      targetMeanPrice: null, analystStrongBuy: 0, analystBuy: 0, analystHold: 0,
      analystSell: 0, analystStrongSell: 0,
    });
    const empty = computeFactorScore({
      financials:    blank,
      metrics:       computeAllMetrics(blank, FALLBACK_RATES, null),
      sectorMedians: null, marketSignals: null, technicalSignals: null,
    });

    assert.ok(empty.pillars.every((p) => p.score === null), 'fixture should score nothing');

    // Knowing nothing is neutral. Before the guard this fell through to raw 0
    // and printed a confident STRONG SELL.
    assert.equal(empty.raw, 5);
    assert.ok(Math.abs(empty.score - 5) < 1e-9);
    assert.equal(empty.verdict, 'HOLD');
  });

  it('names the widest disagreements once, not every pair that shares a cause', () => {
    // Valuation far below four other pillars is one observation, not four.
    const s = score({ price: 600, targetMeanPrice: 900 });
    const divergences = s.findings.filter((x) => x.kind === 'divergence' && x.pillar === null);
    assert.ok(divergences.length <= 3, `got ${divergences.length} divergence lines`);
  });

  it('reports an unscorable pillar as a gap rather than staying silent', () => {
    const blind = score({}, { signals: null, technicals: null });
    const gaps = blind.findings.filter((x) => x.kind === 'gap');
    assert.ok(gaps.some((g) => g.pillar === 'momentum'));
  });
});

describe('uncertainty', () => {
  it('pulls a flagged payload toward neutral instead of trusting it', () => {
    const clean = score();
    const flagged = score({ dataQualityWarnings: [ERROR_WARNING] });

    assert.ok(flagged.confidence < clean.confidence);
    assert.ok(Math.abs(flagged.score - 5) < Math.abs(clean.score - 5),
      `flagged ${flagged.score} should sit closer to 5 than clean ${clean.score}`);
    // The arithmetic itself is untouched — only the trust in it changed.
    assert.equal(flagged.raw, clean.raw);
  });

  it('caps conviction on a flagged payload, and says why', () => {
    const flagged = score({ dataQualityWarnings: [ERROR_WARNING] });
    assert.ok(flagged.caps.some((c) => c.limit === 'no-strong'));
    assert.notEqual(flagged.verdict, 'STRONG BUY');
    assert.notEqual(flagged.verdict, 'STRONG SELL');
    assert.ok(flagged.findings.some((x) => x.kind === 'cap'));
  });

  it('caps an uncovered listing, because the models lost their only check', () => {
    const uncovered = score({
      analystStrongBuy: 0, analystBuy: 0, analystHold: 0, analystSell: 0,
      analystStrongSell: 0, targetMeanPrice: null,
    });
    assert.ok(uncovered.caps.some((c) => /Analystenabdeckung/.test(c.reason)));
    assert.ok(!uncovered.verdict.startsWith('STRONG'));
  });

  it('never lets a cap upgrade a bearish verdict', () => {
    // A distressed, flagged, expensive company: the ceiling must not lift SELL.
    const bad = score({
      price: 1000, freeCashFlow: -50_000_000, ebit: -20_000_000, eps: -2,
      totalDebt: 900_000_000, totalCash: 1_000_000, currentRatio: 0.4,
      targetMeanPrice: 400, analystStrongBuy: 0, analystBuy: 0, analystHold: 2,
      analystSell: 5, analystStrongSell: 4,
      dataQualityWarnings: [ERROR_WARNING],
    });
    assert.ok(['SELL', 'HOLD', 'STRONG SELL'].includes(bad.verdict));
  });
});

describe('analyst consensus', () => {
  it('weights Strong Buy at +2 and normalises into [−1, +1]', () => {
    const c = analystConsensus(financials());
    // (8×2 + 6 − 1) / (18×2) = 21/36
    assert.ok(Math.abs((c.score ?? 0) - 21 / 36) < 1e-9);
    assert.equal(c.label, 'BULLISH');
    assert.equal(c.total, 18);
    assert.ok(Math.abs((c.upside ?? 0) - 0.25) < 1e-9);
  });

  it('separates "no ratings" from "no coverage at all"', () => {
    const targetOnly = analystConsensus(financials({
      analystStrongBuy: 0, analystBuy: 0, analystHold: 0, analystSell: 0, analystStrongSell: 0,
    }));
    const nothing = analystConsensus(financials({
      analystStrongBuy: 0, analystBuy: 0, analystHold: 0, analystSell: 0,
      analystStrongSell: 0, targetMeanPrice: null,
    }));

    assert.equal(targetOnly.uncovered, false);
    assert.equal(targetOnly.score, null);
    assert.equal(nothing.uncovered, true);
  });
});

describe('blending the two halves', () => {
  const factor = score();

  const blend = (over: Partial<Parameters<typeof blendScores>[0]> = {}) => blendScores({
    factor, narrativeScore: 5, narrativeConfidence: 1,
    adjustment: 0, adjustmentReason: null, ...over,
  });

  it('falls back to the factor score when there is no narrative', () => {
    const b = blend({ narrativeScore: null, narrativeConfidence: 0 });
    assert.equal(b.blend, factor.score);
    assert.equal(b.narrativeWeight, 0);
  });

  it('hands weight to the prose exactly as the numbers lose confidence', () => {
    const confident = blendScores({
      factor: { ...factor, confidence: 0.9 },
      narrativeScore: 5, narrativeConfidence: 1, adjustment: 0, adjustmentReason: null,
    });
    const doubtful = blendScores({
      factor: { ...factor, confidence: 0.2 },
      narrativeScore: 5, narrativeConfidence: 1, adjustment: 0, adjustmentReason: null,
    });

    assert.ok(doubtful.narrativeWeight > confident.narrativeWeight);
    // The arithmetic still leads when it is trusted.
    assert.ok(confident.factorWeight > confident.narrativeWeight);
  });

  it('clamps the model correction and drops a reason for a zero one', () => {
    const over = blend({ adjustment: 5, adjustmentReason: 'Übernahmeangebot' });
    const under = blend({ adjustment: -5, adjustmentReason: 'Rückruf' });
    const none = blend({ adjustment: 0, adjustmentReason: 'sollte verschwinden' });

    assert.equal(over.adjustment, 1);
    assert.equal(under.adjustment, -1);
    assert.equal(none.adjustmentReason, null);
  });

  it('keeps the caps: prose cannot argue past a flagged balance sheet', () => {
    const flagged = score({ dataQualityWarnings: [ERROR_WARNING] });
    const b = blendScores({
      factor: flagged, narrativeScore: 10, narrativeConfidence: 1,
      adjustment: 1, adjustmentReason: 'Rekordquartal', adjustmentLimit: 1,
    });
    assert.ok(!b.verdict.startsWith('STRONG'));
  });
});
