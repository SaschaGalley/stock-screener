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

import { adjustedCurrentRatio, analystConsensus, blendScores, combineNarrativeReads, computeFactorScore, marketImplied, convictionFor, fairValueRange, intrinsicValue, PILLAR_WEIGHTS, readAltman, readBeneish, capVerdict, saturate, unsaturate } from '../src/analysis/score.js';
import { recommendationTone, verdictForScore } from '../src/verdict.js';
import { computeAllMetrics } from '../src/analysis/computeMetrics.js';
import { FALLBACK_RATES } from '../src/data/fred.js';
import { PILLAR_KEYS } from '../src/types.js';
import type {
  DataQualityWarning, MarketSignals, SectorMedians, ScorePillar, StockFinancials, TechnicalSignals,
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

  it('does not read a lone analyst target as a perfect valuation', () => {
    // No FCF, no EPS, no book value and no peers: everything drops out of the
    // primary tier except the analyst target, which on a speculative name sits
    // far above the price. That is a price forecast, not a valuation of this
    // company's own figures, and it is already the consensus pillar's job.
    const thin = financials({
      freeCashFlow: null, ebit: null, ebitda: null, eps: null, bookValue: null,
      earningsGrowth: null, revenueGrowth: null, targetMeanPrice: 260,
    });
    const metrics = computeAllMetrics(thin, FALLBACK_RATES, null);
    const s = computeFactorScore({
      financials: thin, metrics, sectorMedians: null,
      marketSignals: signals, technicalSignals: technicals,
    });

    assert.equal(intrinsicValue(thin, metrics.composite).models.length, 0,
      'the target must not count as one of our models');

    const valuation = s.pillars.find((p) => p.key === 'valuation');
    const composite = valuation?.criteria.find((c) => c.key === 'composite-mos');

    assert.equal(composite?.points, null, 'nothing of our own survived, so it abstains');
    assert.match(composite?.note ?? '', /Analystenziel/);
    assert.ok((valuation?.coverage ?? 1) < 1, 'the loss is charged to coverage');
  });

  it('reads a single model of our own, which a single forecast is not', () => {
    // One real method applied to this company's figures is thin evidence but it
    // is evidence; blinding the pillar on it would cost 16 of 37 stocks.
    const f = financials({ targetMeanPrice: 130 });
    const { models, mos } = intrinsicValue(f, computeAllMetrics(f, FALLBACK_RATES, null).composite);

    assert.ok(models.length >= 1);
    assert.ok(!models.some((m) => m.name === 'Analyst Consensus'));
    assert.ok(mos !== null);
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

describe('caps', () => {
  const cap = (limit: 'no-strong' | 'hold-ceiling') => [{ limit, reason: 'x' }] as never;
  it('lets a warning cap enthusiasm but never soften alarm', () => {
    assert.equal(capVerdict('STRONG BUY', cap('hold-ceiling')), 'HOLD');
    assert.equal(capVerdict('BUY', cap('hold-ceiling')), 'HOLD');
    assert.equal(capVerdict('STRONG SELL', cap('hold-ceiling')), 'STRONG SELL');
  });
  it('lets uncertainty temper both extremes', () => {
    assert.equal(capVerdict('STRONG BUY', cap('no-strong')), 'BUY');
    assert.equal(capVerdict('STRONG SELL', cap('no-strong')), 'SELL');
  });
});

describe('reading the Z-Score', () => {
  const z = (over: Partial<StockFinancials>, metricsOver: Record<string, unknown> = {}) => {
    const f = financials(over);
    const m = computeAllMetrics(f, FALLBACK_RATES, peers);
    return readAltman(f, {
      ...m,
      altmanZ: { score: -2.5, zone: 'distress', model: 'modified', x2: -1.15,
        thresholds: { safe: 2.6, distress: 1.11 } } as never,
      ...metricsOver,
    } as never);
  };

  it('does not call a company with net cash distressed', () => {
    // Rubrik's shape: a decade of venture-funded losses puts retained earnings
    // at −115 % of assets and Z at −2.52, while it holds $603M in net cash.
    // There is nothing to default on.
    const r = z({ totalCash: 700_000_000, totalDebt: 50_000_000 });
    assert.equal(r.reading, 'deficit-driven');
    assert.match(r.note, /Nettoliquidität/);
  });

  it('does not call debt covered sixteen times over distressed', () => {
    const r = z({ totalCash: 0, totalDebt: 500_000_000 },
      { interestCoverage: { ratio: 16.6, interpretation: 'excellent' } });
    assert.equal(r.reading, 'serviced');
  });

  it('keeps the reading when there is debt it cannot serve', () => {
    const r = z({ totalCash: 1_000_000, totalDebt: 900_000_000 },
      { interestCoverage: { ratio: 0.4, interpretation: 'critical' } });
    assert.equal(r.reading, 'distress');
  });

  it('does not read a utility at all, whatever its zone', () => {
    // Vistra: Z 1.33 on the manufacturer model, X5 0.46, X2 ≈ 0 after
    // fresh-start accounting — and debt it does not serve at the excellent mark.
    const r = z({ sector: 'Utilities', totalCash: 1_000_000, totalDebt: 900_000_000 },
      { interestCoverage: { ratio: 2.1, interpretation: 'fair' } });
    assert.equal(r.reading, 'out-of-sample');
    assert.match(r.note, /Versorgern/);
  });

  it('caps only on the reading that survived, and the criterion follows it', () => {
    const cashRich = financials({ totalCash: 700_000_000, totalDebt: 50_000_000 });
    const s = computeFactorScore({
      financials: cashRich,
      metrics: computeAllMetrics(cashRich, FALLBACK_RATES, peers),
      sectorMedians: peers, marketSignals: signals, technicalSignals: technicals,
    });
    const altman = s.pillars.find((p) => p.key === 'health')
      ?.criteria.find((c) => c.key === 'altman');

    assert.equal(altman?.note, readAltman(cashRich, computeAllMetrics(cashRich, FALLBACK_RATES, peers)).note);
    assert.ok(!s.caps.some((c) => /Distress/.test(c.reason)));
  });
});

describe('an uncorroborated model', () => {
  it('abstains when it lands far from the price with nothing to check it', () => {
    // Rubrik's lone DCF said $522.81 against a $102.23 price and took the top
    // of the ranking; the ramp tops out at +60 % MoS, so five-times-the-price
    // scored exactly what solidly-cheap does.
    const f = financials({ price: 100 });
    const comp = computeAllMetrics(f, FALLBACK_RATES, peers).composite;
    const lone = (fairValue: number) => intrinsicValue(f, {
      ...comp, primary: { ...comp.primary, models: [{ name: 'DCF (2-Stage FCFF)', fairValue }] },
    });

    assert.equal(lone(500).mos, null, '5× the price is extrapolation');
    assert.equal(lone(20).mos, null, '0.2× the price likewise');
    assert.ok(lone(180).mos !== null, '1.8× is a claim worth weighing');
    assert.ok(lone(60).mos !== null);
  });

  it('lets a corroborated outlier stand, because its neighbours correct it', () => {
    const f = financials({ price: 100 });
    const comp = computeAllMetrics(f, FALLBACK_RATES, peers).composite;
    const pair = intrinsicValue(f, {
      ...comp,
      primary: { ...comp.primary, models: [
        { name: 'DCF (2-Stage FCFF)', fairValue: 500 },
        { name: 'Peer Multiples', fairValue: 120 },
      ] },
    });
    assert.ok(pair.mos !== null, 'the median of the two is 310, and two models is a reading');
  });
});

describe('reading the M-Score', () => {
  const b = (over: Record<string, unknown>) => readBeneish(financials(), {
    score: -1.0, probability: 'likely manipulator', variablesComputed: 8,
    dsri: 0.9, gmi: 1.0, aqi: 1.1, sgi: 1.5, depi: 1.0, sgai: 1.0, tata: 0.05, lvgi: 1.0,
    ...over,
  } as never);

  it('refuses a linear model evaluated far outside its estimation range', () => {
    // Ondas: revenue up more than twelvefold, M-Score 16.97 against a −1.78
    // threshold. The SGI coefficient alone accounts for most of that.
    const r = b({ score: 16.97, sgi: 24.2, tata: -0.08 });
    assert.equal(r.reading, 'extrapolated');
    assert.match(r.note, /außerhalb/);
  });

  it('reads growth plus cash-backed earnings as growth, not manipulation', () => {
    // CoreWeave's shape: sales index 3.96, accruals negative — operating cash
    // flow exceeds net income, the opposite of the pattern being hunted.
    assert.equal(b({ sgi: 1.9, tata: -0.09 }).reading, 'growth-explained');
  });

  it('keeps the flag when the accruals support it, however fast sales grew', () => {
    // Nvidia's shape: fast growth, but net income above operating cash flow.
    const r = b({ sgi: 1.94, tata: 0.08 });
    assert.equal(r.reading, 'flagged');
    assert.match(r.note, /TATA 0\.08/);
  });

  it('needs growth as well as cash — a slow grower keeps its flag', () => {
    assert.equal(b({ sgi: 1.05, tata: -0.05 }).reading, 'flagged');
  });

  it('gives the criterion and the cap one reading, never two', () => {
    const grown = financials({ revenueGrowth: 2.0 });
    const s = computeFactorScore({
      financials: grown,
      metrics: computeAllMetrics(grown, FALLBACK_RATES, peers),
      sectorMedians: peers, marketSignals: signals, technicalSignals: technicals,
    });
    const health = s.pillars.find((p) => p.key === 'health');
    const note = health?.criteria.find((c) => c.key === 'beneish')?.note;

    assert.equal(note, readBeneish(grown, computeAllMetrics(grown, FALLBACK_RATES, peers).beneish).note);
  });

  it('stands down for a lender, whose receivables are the product', () => {
    // SoFi and Mastercard share the industry string "Credit Services" and even
    // their debt-to-revenue is close (0.80 vs 0.70). Interest separates them by
    // a factor of thirteen: a lender funds its own book.
    const lender = financials({ sector: 'Financial Services', industry: 'Credit Services',
      revenue: 1_000_000, interestExpense: 270_000 });
    const network = financials({ sector: 'Financial Services', industry: 'Credit Services',
      revenue: 1_000_000, interestExpense: 20_000 });

    assert.equal(b({}).reading, 'flagged', 'the fixture is a flag to begin with');
    assert.equal(readBeneish(lender, { score: -1.0, probability: 'likely manipulator',
      variablesComputed: 8, sgi: 1.5, tata: 0.05 } as never).reading, 'not-applicable');
    assert.equal(readBeneish(network, { score: -1.0, probability: 'likely manipulator',
      variablesComputed: 8, sgi: 1.5, tata: 0.05 } as never).reading, 'flagged');
  });

  it('abstains rather than scoring zero when the model could not be computed', () => {
    assert.equal(b({ variablesComputed: 3 }).reading, 'unavailable');
    assert.equal(b({ probability: 'unknown', variablesComputed: 2 }).reading, 'unavailable');
  });
});

describe('conviction', () => {
  const pillar = (key: string, score: number | null, effectiveWeight: number) =>
    ({ key, label: key, score, weight: effectiveWeight, effectiveWeight, coverage: 1, criteria: [] }) as ScorePillar;

  const even = (scores: (number | null)[]) => {
    const live = scores.filter((x) => x !== null).length;
    return scores.map((x, i) => pillar(PILLAR_KEYS[i], x, x === null ? 0 : 1 / live));
  };

  it('is full when every pillar points the same way, in either direction', () => {
    const bullish = convictionFor(even([8, 7, 9, 8, 7, 8]));
    const bearish = convictionFor(even([2, 3, 1, 2, 3, 2]));

    assert.ok(Math.abs(bullish.agreement - 1) < 1e-9);
    assert.ok(Math.abs(bearish.agreement - 1) < 1e-9);
    assert.equal(bullish.conviction, bearish.conviction);
    assert.ok(bullish.conviction > 1.5);
  });

  it('is none when the pillars cancel — a standoff keeps its compromise', () => {
    // Apple's shape: violently cheap-vs-quality, averaging to the middle.
    const { agreement, conviction } = convictionFor(even([0, 10, 0, 10, 0, 10]));
    assert.ok(Math.abs(agreement) < 1e-9);
    assert.equal(conviction, 1);
  });

  it('scales in between rather than switching', () => {
    const a = convictionFor(even([8, 8, 8, 8, 8, 2])).agreement;
    const b = convictionFor(even([8, 8, 8, 8, 2, 2])).agreement;
    assert.ok(a > b && b > 0 && a < 1);
  });

  it('gives a unanimity of one or two pillars nothing', () => {
    const lonely = convictionFor(even([9, null, null, null, null, null]));
    const pair   = convictionFor(even([9, 9, null, null, null, null]));
    const trio   = convictionFor(even([9, 9, 9, null, null, null]));

    assert.ok(Math.abs(lonely.agreement - 1) < 1e-9, 'one pillar trivially agrees with itself');
    assert.equal(lonely.conviction, 1, 'but that is not corroboration');
    assert.equal(pair.conviction, 1);
    assert.ok(trio.conviction > 1);
  });

  it('composes with trust rather than replacing it', () => {
    // The headline is the raw deviation times both multipliers (bent only past
    // the STRONG bands — see `saturate`), and the two
    // answer different questions: how much of this can we trust, and how much
    // of it do the lenses corroborate.
    const s = score();
    const expected = 5 + saturate((s.raw - 5) * s.shrink * s.conviction);

    // Half a tenth: the published score is rounded to the decimal everything
    // prints and bands on.
    assert.ok(Math.abs(s.score - expected) <= 0.05, `${s.score} vs ${expected}`);
    assert.ok(Math.abs(s.conviction - convictionFor(s.pillars).conviction) < 1e-9);
  });
});

describe('fair value range', () => {
  it('spans our own models and never the conservative floor', () => {
    // The first live run asked a model for this and got "€74–€173" beside a
    // €208 price: it paired a Graham/EPV floor with an intrinsic value because
    // both were on the card. The span is now the models that produced it.
    const f = financials();
    const comp = computeAllMetrics(f, FALLBACK_RATES, peers).composite;
    const range = fairValueRange(f, comp);
    const own = intrinsicValue(f, comp).models.map((m) => m.fairValue).sort((a, b) => a - b);

    assert.ok(own.length >= 1, 'fixture should produce at least one model');
    assert.ok(range.includes(own[0].toFixed(2)), `${range} should include its low end ${own[0]}`);
    assert.ok(range.includes(own[own.length - 1].toFixed(2)));
    if (own.length >= 2) {
      // The median leads, so an outlier cannot define the headline figure.
      const iv = intrinsicValue(f, comp);
      assert.ok(range.startsWith(`$${(iv.fair as number).toFixed(2)}`), `${range} should lead with the median`);
      assert.match(range, new RegExp(`${own.length} Modelle`));
    }
    if (comp.conservative.median !== null) {
      assert.ok(!range.includes(comp.conservative.median.toFixed(2)),
        'the value-lens floor is not one end of the headline range');
    }
  });

  it('prints one figure rather than a range when one model survives', () => {
    const f = financials();
    const comp = computeAllMetrics(f, FALLBACK_RATES, peers).composite;
    const one = { ...comp, primary: { ...comp.primary, models: [comp.primary.models[0]] } };
    assert.ok(!fairValueRange(f, one).includes('–'));
  });

  it('says N/A rather than inventing one when nothing of ours applies', () => {
    const blank = financials({
      freeCashFlow: null, ebit: null, ebitda: null, eps: null, bookValue: null,
      earningsGrowth: null, revenueGrowth: null,
    });
    assert.equal(fairValueRange(blank, computeAllMetrics(blank, FALLBACK_RATES, null).composite), 'N/A');
  });
});

describe('score bands', () => {
  it('puts each boundary in the band that starts there', () => {
    const cases: [number, string][] = [
      [10, 'STRONG BUY'], [8.0, 'STRONG BUY'], [7.99, 'BUY'],
      [6.5, 'BUY'], [6.49, 'HOLD'],
      [4.5, 'HOLD'], [4.49, 'SELL'],
      [3.0, 'SELL'], [2.99, 'STRONG SELL'], [0, 'STRONG SELL'],
    ];
    for (const [score, verdict] of cases) {
      assert.equal(verdictForScore(score), verdict, `${score} should be ${verdict}`);
    }
  });

  it('is the only definition, so a colour cannot disagree with its badge', () => {
    // The list used to colour from 7 and 5 while the chip beside it came from
    // these bands: 4.6 was a red number on an amber HOLD, 6.6 an amber number
    // on a green BUY. Both now derive from `recommendationTone(verdictFor…)`,
    // which is what this asserts — the two zones that used to disagree.
    assert.equal(recommendationTone(verdictForScore(4.6)), 'neutral');
    assert.equal(recommendationTone(verdictForScore(6.6)), 'positive');
    assert.equal(recommendationTone(verdictForScore(4.4)), 'negative');
    assert.equal(recommendationTone(verdictForScore(6.4)), 'neutral');
  });

  it('agrees with the score the scorer produces', () => {
    const s = score();
    assert.equal(s.uncappedVerdict, verdictForScore(s.score));
  });

  it('leaves a mid-range verdict alone when the cap cannot reach it', () => {
    // The marker in the list means "the label was held back", and this is why
    // it cannot mean "a cap exists": `no-strong` on a stock scoring 6.6 forbids
    // a label that was never on the table, so BUY stands and nothing was
    // capped. The list used to print ⛔ beside exactly this row.
    const base = score();
    const withCap = blendScores({
      factor: {
        ...base, confidence: 1, agreement: 1, score: 6.6,
        caps: [{ limit: 'no-strong', reason: 'Konfidenz zu niedrig' }],
      },
      narrativeScore: 6.6, narrativeConfidence: 1, adjustment: 0, adjustmentReason: null,
    });

    assert.equal(withCap.verdict, 'BUY');
    assert.equal(withCap.verdict, verdictForScore(withCap.score), 'nothing was held back');
  });

  it('holds a high score back when the cap can reach it', () => {
    const base = score();
    const held = blendScores({
      factor: {
        ...base, confidence: 1, agreement: 1, score: 8.5,
        caps: [{ limit: 'hold-ceiling', reason: 'Altman Z im Distress-Bereich' }],
      },
      narrativeScore: 8.5, narrativeConfidence: 1, adjustment: 0, adjustmentReason: null,
    });

    assert.equal(verdictForScore(held.score), 'STRONG BUY');
    assert.equal(held.verdict, 'HOLD', 'hold-ceiling takes STRONG BUY down through BUY');
  });

  it('bands the number that is printed, not a more precise one behind it', () => {
    // A score of 4.4987 stores and prints as 4.5 but used to band as SELL,
    // so one 4.5 said SELL while the 4.5 beside it said HOLD. The published
    // value is now the only one anything reads.
    for (let raw = 0; raw <= 100; raw++) {
      const s = blendScores({
        factor: { ...score(), confidence: 1, caps: [] },
        narrativeScore: raw / 10, narrativeConfidence: 1,
        adjustment: 0, adjustmentReason: null, narrativeMaxWeight: 1,
      });
      assert.equal(s.score, Math.round(s.score * 10) / 10, `${s.score} is not published to one decimal`);
      assert.equal(s.verdict, verdictForScore(s.score), `${s.score} banded as ${s.verdict}`);
    }
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

  it('hands weight to the prose when the pillars cancel, not only when data is thin', () => {
    // Two factor halves, equally trustworthy, equally neutral — one because it
    // says nothing, the other because its lenses fought to a draw. Only the
    // second should let the narrative through.
    const speaks = blendScores({
      factor: { ...factor, confidence: 0.9, agreement: 0.95, score: 5 },
      narrativeScore: 8, narrativeConfidence: 1, adjustment: 0, adjustmentReason: null,
    });
    const draws = blendScores({
      factor: { ...factor, confidence: 0.9, agreement: 0.02, score: 5 },
      narrativeScore: 8, narrativeConfidence: 1, adjustment: 0, adjustmentReason: null,
    });

    assert.ok(draws.narrativeWeight > speaks.narrativeWeight);
    assert.ok(draws.score > speaks.score, 'a standoff lets the prose move the headline');
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

    assert.equal(over.adjustmentRequested, 1);
    assert.equal(under.adjustmentRequested, -1);
    assert.equal(none.adjustmentReason, null);
  });

  it('applies a correction exactly inside the bands and bends it towards the ends', () => {
    const at = (factorScore: number, adjustment: number) => blendScores({
      factor: { ...score(), score: factorScore, confidence: 1, agreement: 1 },
      narrativeScore: null, narrativeConfidence: 0,
      adjustment, adjustmentReason: 'Anlass',
    });
    const middle = at(6.0, 1);
    assert.ok(Math.abs(middle.adjustment - 1) < 0.01 && middle.score === 7);

    // A 9.4 used to become 10.4, clipped to a perfect 10 and recorded as +1.0.
    const top = at(9.4, 1);
    assert.ok(top.score < 10 && top.score > 9.4);
    assert.ok(Math.abs(top.score - (top.blend + top.adjustment)) <= 0.05);
    assert.equal(top.adjustmentRequested, 1);
    assert.ok(top.adjustment < 1);

    const bottom = at(0.8, -1);
    assert.ok(bottom.score > 0 && bottom.score < 0.8);
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

describe('narrative reads', () => {
  const read = (score: number | null, tag = String(score)) => ({ summary: tag, events: [], score });

  it('keeps the median read, prose and number together, and ignores one outlier', () => {
    const c = combineNarrativeReads([read(5, 'a'), read(7, 'b'), read(5, 'c')])!;
    assert.equal(c.score, 5);
    assert.equal(c.read.score, 5);
    assert.equal(c.spread, 2);
    assert.ok(c.confidenceFactor < 1 && c.confidenceFactor > 0.5);
  });

  it('abstains when most reads abstain', () => {
    assert.equal(combineNarrativeReads([read(null), read(null), read(8)])!.score, null);
    assert.equal(combineNarrativeReads([read(null), read(6), read(8)])!.score, 6);
  });

  it('never removes more than half the confidence, and none at agreement', () => {
    assert.equal(combineNarrativeReads([read(6), read(6), read(6)])!.confidenceFactor, 1);
    assert.equal(combineNarrativeReads([read(1), read(5), read(9)])!.confidenceFactor, 0.5);
  });

  it('takes the conservative middle on an even count, and survives a lone read', () => {
    assert.equal(combineNarrativeReads([read(4), read(6)])!.score, 4);
    const lone = combineNarrativeReads([read(7)])!;
    assert.equal(lone.score, 7);
    assert.equal(lone.spread, null);
    assert.equal(combineNarrativeReads([]), null);
  });
});

describe('what the price requires', () => {
  const base = financials();
  const metrics = computeAllMetrics(base, FALLBACK_RATES, null);
  const withMargin = (over: Record<string, number | null>) => ({
    ...metrics,
    reverseDCF: {
      ...metrics.reverseDCF,
      impliedMargin: {
        fcfMargin: 0.20, revenueBase: 1, revenueGrowth: 0.1, growthSource: 'analyst consensus' as const,
        discountRate: 0.09, currentFcfMargin: 0.10, currentNopatMargin: 0.10, interpretation: '',
        ...over,
      },
    },
  });

  it('holds the requirement against the best margin already shown', () => {
    const r = marketImplied(base, withMargin({ currentNopatMargin: 0.03, currentFcfMargin: 0.30 }), null)!;
    assert.equal(r.basis, 'fcf');
    assert.ok(Math.abs(r.ratio - 0.2 / 0.3) < 1e-9);
  });

  it('abstains where no positive margin exists to compare with', () => {
    assert.equal(marketImplied(base, withMargin({ currentNopatMargin: -0.1, currentFcfMargin: -0.5 }), null), null);
  });

  it('ignores the median of a thin peer group', () => {
    const thin = { operatingMargin: 0.9, peerCount: 2 } as SectorMedians;
    assert.notEqual(marketImplied(base, withMargin({}), thin)!.basis, 'peers');
    const real = { operatingMargin: 0.9, peerCount: 8 } as SectorMedians;
    assert.equal(marketImplied(base, withMargin({}), real)!.basis, 'peers');
  });

  it('reads 5 at exactly the achievable margin, and 0 / 10 at twice / half of it', () => {
    const pts = (req: number) => computeFactorScore({
      financials: base, metrics: withMargin({ fcfMargin: req }), sectorMedians: null,
      marketSignals: null, technicalSignals: null,
    }).pillars.find((p) => p.key === 'valuation')!.criteria.find((c) => c.key === 'market-implied')!.points!;
    assert.ok(Math.abs(pts(0.10) - 0.5) < 1e-9);
    assert.equal(pts(0.20), 0);
    assert.equal(pts(0.05), 1);
  });
});

describe('current ratio of a subscription business', () => {
  it('sets prepaid revenue aside once it is a material share of current liabilities', () => {
    const r = adjustedCurrentRatio(financials({ currentRatio: 0.7, deferredRevenueShare: 0.8 }));
    assert.ok(Math.abs(r.ratio! - 3.5) < 1e-9);
    assert.equal(r.deferredShare, 0.8);
  });
  it('reads an ordinary balance sheet as reported', () => {
    assert.deepEqual(adjustedCurrentRatio(financials({ currentRatio: 1.2, deferredRevenueShare: 0.1 })), { ratio: 1.2, deferredShare: null });
    assert.deepEqual(adjustedCurrentRatio(financials({ currentRatio: 1.2, deferredRevenueShare: null })), { ratio: 1.2, deferredShare: null });
  });
});

describe('conservative models outside their population', () => {
  const names = (over: Partial<StockFinancials>) => {
    const m = computeAllMetrics(financials(over), FALLBACK_RATES, null);
    return {
      used: m.composite.conservative.models.map((x) => x.name),
      excluded: m.composite.excludedModels.map((x) => `${x.name}: ${x.reason}`),
    };
  };

  it('does not anchor on a book the firm has handed back', () => {
    const r = names({ roe: 1.5 });
    assert.ok(!r.used.includes('Graham Number') && !r.used.includes('Residual Income (RIM)'));
    assert.ok(r.excluded.some((e) => /Graham Number: ROE 150/.test(e)));
  });

  it('does not value a token dividend as the business', () => {
    const r = names({ dividendYield: 0.01, payoutRatio: 0.1 });
    assert.ok(!r.used.includes('DDM (Gordon)'));
    assert.ok(r.excluded.some((e) => /DDM \(Gordon\): Payout 10/.test(e)));
  });

  it('reads an ordinary balance sheet with every model', () => {
    const r = names({ roe: 0.15, dividendYield: 0.03, payoutRatio: 0.6 });
    assert.ok(!r.excluded.some((e) => /not the capital base|not how this firm distributes/.test(e)));
  });
});

describe('saturation at the ends of the scale', () => {
  it('leaves the middle untouched and bends only beyond the STRONG bands', () => {
    assert.equal(saturate(2.5), 2.5);
    assert.equal(saturate(-3), -3);
    assert.ok(saturate(5.24) < 5 && saturate(5.24) > 4.5);
  });
  it('is inverted exactly by unsaturate', () => {
    for (const d of [-4.9, -3.5, -1, 0, 2.2, 3.4, 4.7]) {
      assert.ok(Math.abs(saturate(unsaturate(d)) - d) < 1e-9);
    }
  });

  it('keeps order, meets the line smoothly, and never passes the end', () => {
    let prev = -Infinity;
    for (let d = -12; d <= 12; d += 0.25) {
      const v = saturate(d);
      assert.ok(v > prev && Math.abs(v) < 5);
      prev = v;
    }
    assert.ok(Math.abs(saturate(3.001) - 3.001) < 1e-6);
  });
});

describe('conviction from a mild consensus', () => {
  const pillars = (scores: number[]) => scores.map((score, i) => ({
    key: PILLAR_KEYS[i], label: '', weight: 1 / scores.length, effectiveWeight: 1 / scores.length,
    score, coverage: 1, criteria: [],
  })) as unknown as ScorePillar[];

  it('gives six mild leans less stretch than six strong ones, at the same agreement', () => {
    const mild = convictionFor(pillars([5.5, 5.5, 5.5, 5.5, 5.5, 5.5]));
    const strong = convictionFor(pillars([8, 8, 8, 8, 8, 8]));
    assert.equal(mild.agreement, 1);
    assert.equal(strong.agreement, 1);
    assert.ok(Math.abs(strong.conviction - 1.6) < 1e-9);
    assert.ok(Math.abs(mild.conviction - (1 + 0.6 / 3)) < 1e-9);
  });
});

describe('rates for a past instant', () => {
  it('reads the newest reading before, reaches forward only when none exists, and falls back last', async () => {
    const { ratesAt } = await import('../src/db/rescore.js');
    const h = new Map([
      ['macro.riskFreeRate', [{ at: 100, value: 0.04 }, { at: 200, value: 0.05 }]],
      ['macro.equityRiskPremium', [{ at: 300, value: 0.041 }]],
    ]);
    const r = ratesAt(h, 250);
    assert.equal(r.riskFreeRate, 0.05);
    assert.equal(r.equityRiskPremium, 0.041);       // recorded later, still closer than the constant
    assert.equal(r.aaaBondYield, FALLBACK_RATES.aaaBondYield);
    assert.equal(ratesAt(h, 150).riskFreeRate, 0.04);
  });
});
