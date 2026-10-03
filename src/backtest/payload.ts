/**
 * A company as the scorer would have seen it on a past day.
 *
 * The live payload is built from Yahoo; this one from the SEC's filings as they
 * stood that day (`data/edgar-facts.ts`) and the prices up to that day's close.
 * Both feed the same `computeAllMetrics` and `computeFactorScore`, so what the
 * backtest measures is the scoring code, not a re-implementation of it.
 *
 * The analyst consensus is rebuilt from Yahoo's rating history when it is
 * passed (`analysis/analyst-history.ts`): each firm's newest target and grade
 * from the year before the day. What cannot be rebuilt is left empty, and the
 * criteria that read it abstain: estimates, their revisions and earnings
 * surprises were never published as a history, so the revisions pillar has
 * only the rating drift and the DCF starts from the trailing year's growth
 * instead of the consensus.
 */

import {
  CompanyFacts, Fact, fiscalYears, instantAt, latestInstant, trailingTwelveMonths,
} from '../data/edgar-facts.js';
import { auditFinancials, isFundamentalsStale } from '../analysis/data-quality.js';
import { consensusAt, ratingDeltaAt } from '../analysis/analyst-history.js';
import { TIMING_LOOKBACK, timingReadings } from '../analysis/timing.js';
import type { AnalystAction } from '../analysis/analyst-accuracy.js';
import type { MarketSignals, StockFinancials } from '../types.js';
import { indexAtOrBefore, PriceHistory, splitFactorAfter } from './prices.js';

export interface Company {
  symbol:      string;
  name:        string;
  cik:         string;
  /** GICS sector and sub-industry, from the index file. */
  sector:      string;
  subIndustry: string;
  /** The day it joined the index; before that it is not in the backtest's universe. */
  added:       string | null;
  /** The day it left, for a company that did; from then on it is not either. */
  removed?:    string | null;
}

/** GICS sector names in Yahoo's spelling, which the live code (`borrowsToLend`) and the calibration's sector keys use. */
const YAHOO_SECTOR: Record<string, string> = {
  'Information Technology': 'Technology',
  'Health Care':            'Healthcare',
  'Financials':             'Financial Services',
  'Consumer Discretionary': 'Consumer Cyclical',
  'Consumer Staples':       'Consumer Defensive',
  'Materials':              'Basic Materials',
};

/**
 * GICS sub-industries of companies that borrow as their business, in the
 * Yahoo industry names `isBalanceSheetFinancial` recognises. Every other
 * sub-industry keeps its GICS name, which that check does not match.
 */
const YAHOO_LENDER_INDUSTRY: Record<string, string> = {
  'Diversified Banks':              'Banks - Diversified',
  'Regional Banks':                 'Banks - Regional',
  'Life & Health Insurance':        'Insurance - Life',
  'Property & Casualty Insurance':  'Insurance - Property & Casualty',
  'Multi-line Insurance':           'Insurance - Diversified',
  'Reinsurance':                    'Insurance - Reinsurance',
  'Multi-Sector Holdings':          'Insurance - Diversified',
  'Investment Banking & Brokerage': 'Capital Markets',
};

export function yahooSector(gics: string): string {
  return YAHOO_SECTOR[gics] ?? gics;
}

const DAY_MS = 86_400_000;
/** Trading days in a month and a year, as the live technicals count them. */
const MONTH = 21;
const YEAR = 252;
const QUARTER = 63;

/** Filings more than this far behind the day describe a company that stopped reporting. */
const MAX_STATEMENT_AGE_DAYS = 200;
/**
 * A line whose newest figure is further behind the revenue's than this
 * belongs to a tag the company stopped using. VICI last tagged its operating
 * income for 2020, and every month-end since read 2020's beside the current
 * revenue — a REIT covering its interest 0.4 times. A flow may fall back to
 * the last fiscal year, nine months behind a third quarter; a balance-sheet
 * item should be the quarter's own.
 */
const MAX_FLOW_LAG_DAYS = 370;
const MAX_INSTANT_LAG_DAYS = 200;
/**
 * Interest above this share of revenue with no debt tagged at all means the
 * debt is in the company's own taxonomy, which the SEC's company facts leave
 * out — AES carries 33 billion of it as `aes:` tags — not that there is none.
 */
const UNTAGGED_DEBT_INTEREST_SHARE = 0.005;

function shiftYear(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

const ret = (a: number | undefined, b: number | undefined) => (a && b && a > 0 ? b / a - 1 : null);

/** Beta against the index from up to sixty month-end returns before `i`; null below two years of them. */
function monthlyBeta(px: PriceHistory, bench: PriceHistory, asOf: string): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  let end = asOf;
  for (let m = 0; m < 60; m++) {
    const start = new Date(`${end}T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() - 1);
    const s = start.toISOString().slice(0, 10);
    const a0 = indexAtOrBefore(px.dates, s), a1 = indexAtOrBefore(px.dates, end);
    const b0 = indexAtOrBefore(bench.dates, s), b1 = indexAtOrBefore(bench.dates, end);
    if (a0 < 0 || b0 < 0 || a1 <= a0 || b1 <= b0) break;
    const y = ret(px.adj[a0], px.adj[a1]);
    const x = ret(bench.adj[b0], bench.adj[b1]);
    if (x === null || y === null) break;
    xs.push(x);
    ys.push(y);
    end = s;
  }
  if (xs.length < 24) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, vx = 0;
  for (let k = 0; k < xs.length; k++) { cov += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2; }
  return vx > 0 ? cov / vx : null;
}

export interface PayloadAt {
  financials: StockFinancials;
  signals:    MarketSignals;
}

/**
 * The payload on `asOf` (YYYY-MM-DD): statements filed before that day, prices
 * up to its close, and — given the rating history — the analysts' word from
 * before it. Null when there is too little to score — no price history of a
 * year, no revenue, or statements older than half a year.
 */
export function payloadAt(
  c: Company, facts: CompanyFacts, px: PriceHistory, bench: PriceHistory, sectorEtf: PriceHistory | null, asOf: string,
  analysts: readonly AnalystAction[] | null = null,
): PayloadAt | null {
  const i = indexAtOrBefore(px.dates, asOf);
  if (i < YEAR) return null;
  const price = px.close[i];
  const L = facts.lines;
  const line = (k: string): Fact[] => L[k] ?? [];

  const rev = trailingTwelveMonths(line('revenue'), asOf);
  if (!rev || rev.value <= 0) return null;
  if ((Date.parse(asOf) - Date.parse(rev.end)) / DAY_MS > MAX_STATEMENT_AGE_DAYS) return null;
  const E = rev.end;
  const behind = (end: string) => (Date.parse(E) - Date.parse(end)) / DAY_MS;
  const ttm = (k: string) => {
    const x = trailingTwelveMonths(line(k), asOf);
    return x && behind(x.end) <= MAX_FLOW_LAG_DAYS ? x : null;
  };
  const inst = (k: string) => {
    const x = latestInstant(line(k), asOf);
    return x && behind(x.end) <= MAX_INSTANT_LAG_DAYS ? x : null;
  };

  // Twelve months ending a year before the newest: the same arithmetic on the
  // periods known today that end no later than then.
  const yearBefore = shiftYear(E, -1);
  const ttmBefore = (k: string) => trailingTwelveMonths(
    line(k).filter((f) => f.end <= yearBefore || Math.abs(Date.parse(f.end) - Date.parse(yearBefore)) <= 15 * DAY_MS),
    asOf,
  );

  // Shares on today's basis: the cover page's count, else the quarter's weighted diluted count.
  const coverShares = inst('sharesOutstanding');
  const dilutedTtm = latestDuration(line('dilutedShares'), asOf);
  const shares = coverShares
    ? coverShares.val * splitFactorAfter(px.splits, coverShares.end)
    : dilutedTtm ? dilutedTtm.val * splitFactorAfter(px.splits, dilutedTtm.end) : null;
  if (!shares || shares <= 0) return null;
  const dilutedShares = dilutedTtm ? dilutedTtm.val * splitFactorAfter(px.splits, dilutedTtm.end) : shares;
  const marketCap = price * shares;

  const v = (x: { value: number } | Fact | null | undefined) => (x == null ? null : 'value' in x ? x.value : x.val);
  const revenue = rev.value;
  const cost = v(ttm('costOfRevenue'));
  const grossProfit = v(ttm('grossProfit')) ?? (cost !== null ? revenue - cost : null);
  const netIncome = v(ttm('netIncome'));
  const da = v(ttm('depreciation'));
  const interest = v(ttm('interestExpense'));
  const pretax = v(ttm('pretaxIncome'));
  // Lilly and AES tag no operating income at all, VICI not since 2020; Yahoo's
  // EBIT for them is the pre-tax income with the interest added back, and so
  // is this.
  const ebit = v(ttm('operatingIncome')) ?? (pretax !== null ? pretax + Math.abs(interest ?? 0) : null);
  const ocf = v(ttm('operatingCashFlow'));
  const capexRaw = v(ttm('capex'));
  const capex = capexRaw === null ? null : Math.abs(capexRaw);
  const dividends = v(ttm('dividendsPaid'));

  // Effective tax over the newest three fiscal years together, as the live payload reads it.
  const taxYears = fiscalYears(line('incomeTax'), asOf).slice(-3);
  const pretaxYears = fiscalYears(line('pretaxIncome'), asOf).slice(-3);
  const sumTax = taxYears.reduce((a, x) => a + x.value, 0);
  const sumPretax = pretaxYears.reduce((a, x) => a + x.value, 0);
  const taxRate = taxYears.length && sumPretax > 0 ? Math.max(0, Math.min(0.35, sumTax / sumPretax)) : null;

  // The newest balance sheet, for the bridge from firm value to equity.
  const cash = (v(inst('cash')) ?? 0) + (v(inst('shortInvestments')) ?? 0);
  const longDebt = inst('longTermDebt'), shortDebt = inst('currentDebt');
  // No debt tagged: none, unless the company pays interest on some — then unknown.
  const debt = longDebt || shortDebt
    ? (v(longDebt) ?? 0) + (v(shortDebt) ?? 0)
    : interest !== null && Math.abs(interest) > UNTAGGED_DEBT_INTEREST_SHARE * revenue ? null : 0;
  const equity = v(inst('equity'));
  const assetsNow = v(inst('assets'));
  const currentAssets = v(inst('currentAssets'));
  const currentLiabilities = v(inst('currentLiabilities'));

  // The newest fiscal year, and the one before, for Piotroski and Beneish.
  const fy = fiscalYears(line('revenue'), asOf);
  const fy0 = fy.length ? fy[fy.length - 1].end : null;
  const fy1 = fy.length > 1 ? fy[fy.length - 2].end : null;
  const fyValue = (k: string, end: string | null) =>
    end ? fiscalYears(line(k), asOf).find((x) => Math.abs(Date.parse(x.end) - Date.parse(end)) <= 10 * DAY_MS)?.value ?? null : null;
  const atEnd = (k: string, end: string | null) => (end ? instantAt(line(k), end, asOf) : null);
  const fyShares = (end: string | null) => {
    const s = fyValue('dilutedShares', end);
    return s !== null && end ? s * splitFactorAfter(px.splits, end) : null;
  };

  const history = (k: string) => fiscalYears(line(k), asOf).slice(-5)
    .map((x) => ({ year: Number(x.end.slice(0, 4)), value: x.value }));
  const fcfHistory = fiscalYears(line('operatingCashFlow'), asOf).slice(-5).flatMap((x) => {
    const cx = fyValue('capex', x.end);
    return cx === null ? [] : [{ year: Number(x.end.slice(0, 4)), value: x.value - Math.abs(cx) }];
  });
  const epsHistory = fiscalYears(line('netIncome'), asOf).slice(-5).flatMap((x) => {
    const sh = fyShares(x.end);
    return sh ? [{ year: Number(x.end.slice(0, 4)), value: x.value / sh }] : [];
  });
  const assetsHistory = fy.slice(-5).flatMap((x) => {
    const a = atEnd('assets', x.end);
    return a === null ? [] : [{ year: Number(x.end.slice(0, 4)), value: a }];
  });
  const equityHistory = fy.slice(-5).flatMap((x) => {
    const a = atEnd('equity', x.end);
    return a === null ? [] : [{ year: Number(x.end.slice(0, 4)), value: a }];
  });

  const revPrev = v(ttmBefore('revenue'));
  const niPrev = v(ttmBefore('netIncome'));
  const equityBefore = instantAt(line('equity'), yearBefore, asOf, 45);
  const assetsBefore = instantAt(line('assets'), yearBefore, asOf, 45);

  const eps = netIncome !== null && dilutedShares > 0 ? netIncome / dilutedShares : null;
  const epsNow = epsHistory.length ? epsHistory[epsHistory.length - 1].value : null;
  const eps3y = epsHistory.length >= 4 ? epsHistory[epsHistory.length - 4].value : null;
  const investedCapital = equity !== null && debt !== null ? equity + debt - cash : null;

  const lo52 = Math.max(0, i - YEAR + 1);
  const window52 = px.close.slice(lo52, i + 1);
  const monthlyReturns: number[] = [];
  for (let m = 11; m >= 1; m--) {
    const a = px.adj[i - (m + 1) * MONTH], b = px.adj[i - m * MONTH];
    const r = ret(a, b);
    if (r !== null) monthlyReturns.push(r);
  }

  // Targets are on the basis of their day, the prices on today's.
  const splits = px.splits.map((x) => ({ day: x.date, ratio: x.ratio }));
  const cons = analysts ? consensusAt(analysts, asOf, splits) : null;
  const ratings = cons?.ratings ?? null;

  const gicsIndustry = YAHOO_LENDER_INDUSTRY[c.subIndustry] ?? c.subIndustry;
  const asOfMs = Date.parse(`${asOf}T23:00:00Z`);

  const financials = {
    symbol: c.symbol, companyName: c.name, price, marketCap,
    tradingCurrency: 'USD', financialCurrency: 'USD',
    mostRecentQuarter: E, lastFiscalYearEnd: fy0,
    fundamentalsStale: isFundamentalsStale(E, asOfMs),
    dataQualityWarnings: [],
    peRatio: eps !== null && eps > 0 ? price / eps : null,
    forwardPE: null, avgPE5Y: null, pegRatio: null,
    eps, bookValue: equity !== null ? equity / shares : null,
    roe: netIncome !== null && equity !== null && equityBefore !== null && equity + equityBefore > 0
      ? netIncome / ((equity + equityBefore) / 2) : null,
    roa: netIncome !== null && assetsNow !== null && assetsBefore !== null && assetsNow + assetsBefore > 0
      ? netIncome / ((assetsNow + assetsBefore) / 2) : null,
    operatingMargin: ebit !== null ? ebit / revenue : null,
    netMargin: netIncome !== null ? netIncome / revenue : null,
    revenueGrowth: revPrev !== null && revPrev > 0 ? revenue / revPrev - 1 : null,
    revenueGrowthYoY: revPrev !== null && revPrev > 0 ? revenue / revPrev - 1 : null,
    earningsGrowth: netIncome !== null && niPrev !== null && niPrev > 0 ? netIncome / niPrev - 1 : null,
    freeCashFlow: ocf !== null && capex !== null ? ocf - capex : null,
    operatingCashFlow: ocf,
    totalCash: cash, totalDebt: debt,
    longTermDebt: atEnd('longTermDebt', fy0) ?? v(inst('longTermDebt')),
    debtToEquity: debt !== null && equity !== null && equity > 0 ? debt / equity : null,
    currentRatio: currentAssets !== null && currentLiabilities !== null && currentLiabilities > 0 ? currentAssets / currentLiabilities : null,
    quickRatio: null, deferredRevenueShare: null,
    revenue, grossProfit, ebit, netIncome, normalizedNetIncome: null,
    ebitda: ebit !== null && da !== null ? ebit + da : null,
    interestExpense: interest !== null ? Math.abs(interest) : null,
    incomeTaxExpense: v(ttm('incomeTax')), incomeBeforeTax: v(ttm('pretaxIncome')),
    taxRate,
    totalAssets: atEnd('assets', fy0) ?? assetsNow,
    totalCurrentAssets: currentAssets, totalCurrentLiabilities: currentLiabilities,
    totalLiabilities: atEnd('liabilities', fy0) ?? v(inst('liabilities')) ?? (() => {
      // Lilly and AES tag the two halves and not the total.
      const c = atEnd('currentLiabilities', fy0), n = atEnd('liabilitiesNoncurrent', fy0);
      return c !== null && n !== null ? c + n : null;
    })(),
    retainedEarnings: atEnd('retainedEarnings', fy0) ?? v(inst('retainedEarnings')),
    workingCapital: currentAssets !== null && currentLiabilities !== null ? currentAssets - currentLiabilities : null,
    operatingCashFlowAnnual: fyValue('operatingCashFlow', fy0),
    interestInOperatingCashFlow: true,
    sharesOutstandingAnnual: fyShares(fy0),
    capex, depreciation: fyValue('depreciation', fy0) ?? da,
    stockBasedCompensation: v(ttm('stockComp')),
    trailingSource: 'quarters',
    minorityInterest: v(inst('minorityInterest')), preferredEquity: v(inst('preferredEquity')),
    nonOperatingAssets: v(inst('investments')),
    leaseObligations: null, operatingLeaseLiabilities: null,
    investedCapital: equity !== null && debt !== null ? equity + debt : null,
    tangibleBookValue: equity !== null ? equity - (v(inst('goodwill')) ?? 0) - (v(inst('intangibles')) ?? 0) : null,
    dilutedShareRatio: null,
    enterpriseValue: debt !== null ? marketCap + debt - cash : null,
    sharesOutstanding: shares,
    targetMeanPrice: cons?.targetMean ?? null, analystTargetHigh: cons?.targetHigh ?? null,
    analystTargetLow: cons?.targetLow ?? null, analystTargetMedian: cons?.targetMedian ?? null,
    analystCount: cons?.targetMean != null ? cons.targetFirms : null,
    analystStrongBuy: ratings?.strongBuy ?? null, analystBuy: ratings?.buy ?? null, analystHold: ratings?.hold ?? null,
    analystSell: ratings?.sell ?? null, analystStrongSell: ratings?.strongSell ?? null,
    fiftyTwoWeekHigh: Math.max(...window52), fiftyTwoWeekLow: Math.min(...window52),
    beta: monthlyBeta(px, bench, asOf),
    dividendYield: dividends !== null && marketCap > 0 ? Math.abs(dividends) / marketCap : null,
    payoutRatio: dividends !== null && netIncome !== null && netIncome > 0 ? Math.abs(dividends) / netIncome : null,
    sector: yahooSector(c.sector), industry: gicsIndustry,
    website: null, employees: null, headquarters: null, description: null, isin: null, wkn: null,
    country: 'United States', countryRiskPremium: 0, countryDefaultSpread: 0, marginalTaxRate: 0.25, currencyDefaultSpread: 0,
    roic: ebit !== null && taxRate !== null && investedCapital !== null && investedCapital > 0
      ? ebit * (1 - taxRate) / investedCapital : null,
    epsGrowth3Y: epsNow !== null && eps3y !== null && epsNow > 0 && eps3y > 0 ? (epsNow / eps3y) ** (1 / 3) - 1 : null,
    dividendGrowthRate5Y: null,
    receivables: atEnd('receivables', fy0), ppe: atEnd('ppe', fy0), sga: fyValue('sga', fy0),
    monthlyReturns,
    prevYear: fy1 ? {
      netIncome: fyValue('netIncome', fy1), totalAssets: atEnd('assets', fy1), longTermDebt: atEnd('longTermDebt', fy1),
      currentAssets: atEnd('currentAssets', fy1), currentLiabilities: atEnd('currentLiabilities', fy1),
      grossProfit: fyValue('grossProfit', fy1) ?? ((): number | null => {
        const r = fyValue('revenue', fy1), k = fyValue('costOfRevenue', fy1);
        return r !== null && k !== null ? r - k : null;
      })(),
      revenue: fyValue('revenue', fy1), operatingCashFlow: fyValue('operatingCashFlow', fy1),
      receivables: atEnd('receivables', fy1), ppe: atEnd('ppe', fy1), sga: fyValue('sga', fy1),
      sharesOutstanding: fyShares(fy1), depreciation: fyValue('depreciation', fy1),
    } : null,
    fundamentalsHistory: {
      revenue: history('revenue'), grossProfit: history('grossProfit'), operatingIncome: history('operatingIncome'),
      netIncome: history('netIncome'), eps: epsHistory, freeCashFlow: fcfHistory,
      operatingCashFlow: history('operatingCashFlow'), totalAssets: assetsHistory, stockholdersEquity: equityHistory,
    },
    shortPercentOfFloat: null, shortRatio: null, sharesShort: null, sharesShortPriorMonth: null,
    nextEarningsDate: null, exDividendDate: null, dividendPayDate: null, nextDividendAmount: null,
    institutionsPercentHeld: null, insidersPercentHeld: null, institutionsCount: null,
    earningsSurprises: [], earningsEstimates: [], quarterlyRevenues: [],
    insiderBuyShares: null, insiderSellShares: null, insiderBuyValue: null, insiderSellValue: null,
    insiderBuyCount: null, insiderSellCount: null,
  } as unknown as StockFinancials;
  financials.dataQualityWarnings = auditFinancials(financials, asOfMs);

  // Momentum as the live technicals measure it: sessions, on adjusted closes.
  const at = (k: number) => px.adj[i - k];
  const r3m = ret(at(QUARTER), px.adj[i]);
  let rsSector: number | null = null;
  if (sectorEtf && r3m !== null) {
    const j = indexAtOrBefore(sectorEtf.dates, asOf);
    const s3m = j >= QUARTER ? ret(sectorEtf.adj[j - QUARTER], sectorEtf.adj[j]) : null;
    rsSector = s3m !== null ? r3m - s3m : null;
  }
  const high = Math.max(...px.adj.slice(lo52, i + 1));
  const signals = {
    technicals: {
      returns: {
        d1: ret(at(1), px.adj[i]), w1: ret(at(5), px.adj[i]), m1: ret(at(MONTH), px.adj[i]),
        m3: r3m, m6: ret(at(126), px.adj[i]), ytd: null, y1: ret(at(YEAR), px.adj[i]),
      },
      drawdownFromHighPct: high > 0 ? px.adj[i] / high - 1 : null,
      rsVsSector3M: rsSector,
      // On adjusted closes, as the live bars are.
      timing: timingReadings(px.adj.slice(Math.max(0, i - TIMING_LOOKBACK + 1), i + 1)),
    },
    revisions: { perPeriod: [], analystRatingMoMDelta: analysts ? ratingDeltaAt(analysts, asOf, splits) : null },
    options: null,
    macro: {},
  } as unknown as MarketSignals;

  return { financials, signals };
}

/** The newest duration fact of a line known on `asOf` — a quarter's weighted share count. */
function latestDuration(facts: Fact[], asOf: string): Fact | null {
  let best: Fact | null = null;
  for (const f of facts) {
    if (f.filed >= asOf || f.start === null) continue;
    if (!best || f.end > best.end || (f.end === best.end && f.filed > best.filed)) best = f;
  }
  return best;
}
