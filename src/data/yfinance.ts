/* eslint-disable @typescript-eslint/no-explicit-any */
import YahooFinance from 'yahoo-finance2';
import { PrevYearSnapshot, StockFinancials } from '../types.js';
import { logger } from '../utils/logger.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] } as any);

function num(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  return null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function safeQuote(symbol: string): Promise<any> {
  try { return await yf.quote(symbol); }
  catch (e) { logger.warn(`Quote: ${(e as Error).message}`); return null; }
}

async function safeSummary(symbol: string): Promise<any> {
  try {
    return await yf.quoteSummary(symbol, {
      modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail', 'assetProfile', 'price', 'recommendationTrend'],
    } as any);
  } catch (e) { logger.warn(`Summary: ${(e as Error).message}`); return null; }
}

async function safeHistorical(symbol: string): Promise<number[]> {
  try {
    const from = new Date();
    from.setFullYear(from.getFullYear() - 1);
    const data = await (yf as any).chart(symbol, {
      period1: from.toISOString().slice(0, 10),
      period2: new Date().toISOString().slice(0, 10),
      interval: '1mo',
    });
    const quotes: any[] = data?.quotes ?? [];
    const closes = quotes
      .map((q: any) => q.adjclose ?? q.close)
      .filter((v: any) => typeof v === 'number' && isFinite(v));
    if (closes.length < 2) return [];
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    return returns;
  } catch (e) {
    logger.warn(`Historical: ${(e as Error).message}`);
    return [];
  }
}

async function safeTimeSeries(symbol: string, module: 'balance-sheet' | 'financials' | 'cash-flow'): Promise<any[]> {
  try {
    const from = new Date();
    from.setFullYear(from.getFullYear() - 3);
    const data = await yf.fundamentalsTimeSeries(symbol, {
      period1: from.toISOString().slice(0, 10),
      type: 'annual',
      module,
    } as any);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    logger.warn(`TimeSeries[${module}]: ${(e as Error).message}`);
    return [];
  }
}

// ─── Symbol resolution ────────────────────────────────────────────────────────

export async function resolveSymbol(input: string): Promise<string> {
  // Check if the symbol works directly
  try {
    const q = await yf.quote(input);
    if ((q as any)?.regularMarketPrice) return input;
  } catch { /* fall through to search */ }

  // Yahoo Finance search endpoint
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(input)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return input;
    const data = await res.json() as {
      quotes?: Array<{ symbol?: string; shortname?: string; longname?: string; quoteType?: string; sector?: string; industry?: string }>
    };

    // Prefer genuine equities (sector field set = real company, not ETP/structured product)
    const equities = (data.quotes ?? []).filter((q) => q.quoteType === 'EQUITY' && q.symbol);
    const match = equities.find((q) => q.sector) ?? equities[0];

    if (match?.symbol && match.symbol !== input) {
      logger.info(`Resolved "${input}" → "${match.symbol}" (${match.longname ?? match.shortname ?? ''})`);
      return match.symbol;
    }
  } catch (e) {
    logger.warn(`Symbol lookup failed: ${(e as Error).message}`);
  }

  return input;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function getFinancials(symbol: string): Promise<StockFinancials> {
  logger.step(`Fetching financials for ${symbol}...`);

  const [quote, summary, bsData, finData, cfData, monthlyReturns] = await Promise.all([
    safeQuote(symbol),
    safeSummary(symbol),
    safeTimeSeries(symbol, 'balance-sheet'),
    safeTimeSeries(symbol, 'financials'),
    safeTimeSeries(symbol, 'cash-flow'),
    safeHistorical(symbol),
  ]);

  if (!quote && !summary) throw new Error(`No data found for: ${symbol}`);

  const fd = summary?.financialData        ?? {};
  const ks = summary?.defaultKeyStatistics ?? {};
  const sd = summary?.summaryDetail        ?? {};
  const ap = summary?.assetProfile         ?? {};
  const pr = summary?.price                ?? {};
  const rt = (summary as any)?.recommendationTrend?.trend?.[0] ?? {};

  // Most recent annual period (last element = most recent)
  const bs  = bsData[bsData.length - 1]   ?? {};
  const inc = finData[finData.length - 1]  ?? {};
  const cf  = cfData[cfData.length - 1]    ?? {};

  // Prior year (second-to-last)
  const bs1  = bsData[bsData.length - 2]  ?? null;
  const inc1 = finData[finData.length - 2] ?? null;
  const cf1  = cfData[cfData.length - 2]   ?? null;

  // ── Balance sheet ─────────────────────────────────────────────────────────
  const totalAssets             = num(bs.totalAssets);
  const totalCurrentAssets      = num(bs.currentAssets);
  const totalCurrentLiabilities = num(bs.currentLiabilities);
  const totalLiabilities        = num(bs.totalLiabilitiesNetMinorityInterest);
  const retainedEarnings        = num(bs.retainedEarnings);
  const longTermDebt            = num(bs.longTermDebt);
  const workingCapital          = num(bs.workingCapital)
    ?? (totalCurrentAssets !== null && totalCurrentLiabilities !== null
        ? totalCurrentAssets - totalCurrentLiabilities : null);

  // ── Income statement ──────────────────────────────────────────────────────
  const ebit             = num((inc as any).EBIT) ?? num(inc.operatingIncome);
  const grossProfit      = num(inc.grossProfit);
  const interestExpense  = num(inc.interestExpense)
    ?? num((inc as any).interestExpenseNonOperating);
  const incomeTaxExpense = num(inc.taxProvision);
  const incomeBeforeTax  = num(inc.pretaxIncome);
  const taxRate = incomeTaxExpense && incomeBeforeTax && incomeBeforeTax > 0
    ? incomeTaxExpense / incomeBeforeTax : null;

  // ── Cash flow ─────────────────────────────────────────────────────────────
  const operatingCashFlowAnnual = num(cf.operatingCashFlow);
  const capexRaw = num(cf.capitalExpenditure);
  const capex = capexRaw !== null ? Math.abs(capexRaw) : null;
  const depreciation = num((cf as any).depreciationAndAmortization)
    ?? num((cf as any).depreciation);

  // ── Prior-year snapshot for Piotroski / Beneish ──────────────────────────
  let prevYear: PrevYearSnapshot | null = null;
  if (bs1 && inc1 && cf1) {
    prevYear = {
      netIncome:          num(inc1.netIncome),
      totalAssets:        num(bs1.totalAssets),
      longTermDebt:       num(bs1.longTermDebt),
      currentAssets:      num(bs1.currentAssets),
      currentLiabilities: num(bs1.currentLiabilities),
      grossProfit:        num(inc1.grossProfit),
      revenue:            num(inc1.totalRevenue),
      operatingCashFlow:  num(cf1.operatingCashFlow),
      receivables:        num(bs1.accountsReceivable),
      ppe:                num(bs1.netPPE),
      sga:                num((inc1 as any).sellingGeneralAndAdministration),
      depreciation:       num((cf1 as any).depreciationAndAmortization) ?? num((cf1 as any).depreciation),
    };
  }

  return {
    symbol: symbol.toUpperCase(),
    companyName: str(pr.longName) ?? str(pr.shortName) ?? symbol,
    price: num(quote?.regularMarketPrice) ?? 0,
    marketCap: num(quote?.marketCap) ?? 0,

    peRatio:     num(quote?.trailingPE),
    forwardPE:   num(quote?.forwardPE),
    pegRatio:    num(ks.pegRatio),
    eps:         num(quote?.epsTrailingTwelveMonths),
    bookValue:   num(ks.bookValue),

    roe:              num(fd.returnOnEquity),
    roa:              num(fd.returnOnAssets),
    operatingMargin:  num(fd.operatingMargins) ?? num(quote?.operatingMargins),
    netMargin:        num(fd.profitMargins),
    revenueGrowth:    num(fd.revenueGrowth),
    revenueGrowthYoY: num(fd.revenueGrowth),
    earningsGrowth:   num(fd.earningsGrowth),

    freeCashFlow:      num(fd.freeCashflow),
    operatingCashFlow: num(fd.operatingCashflow),
    totalCash:         num(fd.totalCash),
    totalDebt:         num(fd.totalDebt) ?? num(bs.totalDebt),
    longTermDebt,
    debtToEquity:      num(fd.debtToEquity),
    currentRatio:      num(fd.currentRatio),
    quickRatio:        num(fd.quickRatio),

    revenue:          num(fd.totalRevenue) ?? num(inc.totalRevenue),
    grossProfit:      num(fd.grossProfits) ?? grossProfit,
    ebit,
    netIncome:        num(fd.netIncomeToCommon) ?? num(inc.netIncome),
    ebitda:           num(fd.ebitda),
    interestExpense,
    incomeTaxExpense,
    incomeBeforeTax,
    taxRate,

    totalAssets,
    totalCurrentAssets,
    totalCurrentLiabilities,
    totalLiabilities,
    retainedEarnings,
    workingCapital,

    operatingCashFlowAnnual,
    capex,
    depreciation,

    enterpriseValue:   num(ks.enterpriseValue),
    sharesOutstanding: num(ks.sharesOutstanding),
    targetMeanPrice:   num(fd.targetMeanPrice),

    analystTargetHigh:   num(fd.targetHighPrice),
    analystTargetLow:    num(fd.targetLowPrice),
    analystTargetMedian: num(fd.targetMedianPrice),
    analystCount:        num(fd.numberOfAnalystOpinions),
    analystStrongBuy:    num(rt.strongBuy),
    analystBuy:          num(rt.buy),
    analystHold:         num(rt.hold),
    analystSell:         num(rt.sell),
    analystStrongSell:   num(rt.strongSell),

    fiftyTwoWeekHigh: num(quote?.fiftyTwoWeekHigh),
    fiftyTwoWeekLow:  num(quote?.fiftyTwoWeekLow),
    beta:             num(quote?.beta),
    dividendYield:    num(quote?.dividendYield),
    payoutRatio:      num(sd.payoutRatio),

    sector:   str(ap.sector),
    industry: str(ap.industry),

    website:      str((ap as any).website),
    employees:    num((ap as any).fullTimeEmployees),
    headquarters: [str((ap as any).city), str((ap as any).state), str((ap as any).country)]
                    .filter(Boolean).join(', ') || null,
    description:  str((ap as any).longBusinessSummary),

    roic:                null,
    epsGrowth3Y:         null,
    dividendGrowthRate5Y: null,

    receivables: num(bs.accountsReceivable),
    ppe:         num(bs.netPPE),
    sga:         num((inc as any).sellingGeneralAndAdministration),

    monthlyReturns,

    prevYear,
  };
}
