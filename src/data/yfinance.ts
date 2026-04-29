/* eslint-disable @typescript-eslint/no-explicit-any */
import YahooFinance from 'yahoo-finance2';
import { StockFinancials } from '../types.js';
import { logger } from '../utils/logger.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] } as any);

function num(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function safeQuote(symbol: string): Promise<any> {
  try {
    return await yahooFinance.quote(symbol);
  } catch (e) {
    logger.warn(`Quote fetch failed: ${(e as Error).message}`);
    return null;
  }
}

async function safeSummary(symbol: string): Promise<any> {
  try {
    return await yahooFinance.quoteSummary(symbol, {
      modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail', 'assetProfile'],
    } as any);
  } catch (e) {
    logger.warn(`Summary fetch failed: ${(e as Error).message}`);
    return null;
  }
}

export async function getFinancials(symbol: string): Promise<StockFinancials> {
  logger.step(`Fetching financials for ${symbol}...`);

  const [quote, summary] = await Promise.all([safeQuote(symbol), safeSummary(symbol)]);

  if (!quote && !summary) {
    throw new Error(`No data found for symbol: ${symbol}`);
  }

  const fd = summary?.financialData ?? {};
  const ks = summary?.defaultKeyStatistics ?? {};
  const sd = summary?.summaryDetail ?? {};
  const ap = summary?.assetProfile ?? {};

  return {
    symbol: symbol.toUpperCase(),
    companyName: str(quote?.longName) ?? str(quote?.shortName) ?? symbol,
    price: num(quote?.regularMarketPrice) ?? 0,
    marketCap: num(quote?.marketCap) ?? 0,
    peRatio: num(quote?.trailingPE) ?? num(sd.trailingPE),
    forwardPE: num(quote?.forwardPE),
    pegRatio: num(ks.pegRatio),
    eps: num(quote?.epsTrailingTwelveMonths),
    bookValue: num(ks.bookValue),
    roe: num(fd.returnOnEquity),
    roa: num(fd.returnOnAssets),
    debtToEquity: num(fd.debtToEquity),
    currentRatio: num(fd.currentRatio),
    revenueGrowth: num(fd.revenueGrowth),
    revenueGrowthYoY: num(fd.revenueGrowth),
    operatingMargin: num(fd.operatingMargins) ?? num(quote?.operatingMargins),
    netMargin: num(fd.profitMargins),
    freeCashFlow: num(fd.freeCashflow),
    revenue: num(fd.totalRevenue),
    netIncome: num(fd.netIncomeToCommon),
    ebitda: num(fd.ebitda),
    fiftyTwoWeekHigh: num(quote?.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(quote?.fiftyTwoWeekLow),
    beta: num(quote?.beta),
    dividendYield: num(quote?.dividendYield),
    payoutRatio: num(sd.payoutRatio),
    sector: str(ap.sector),
    industry: str(ap.industry),
  };
}
