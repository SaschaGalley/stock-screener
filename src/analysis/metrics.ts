import { StockFinancials, DCFResult, GrahamResult, RatioResult } from '../types.js';

export interface DCFOptions {
  projectionYears?: number;
  growthRate?: number;
  terminalGrowthRate?: number;
  wacc?: number;
}

export function calculateDCF(financials: StockFinancials, opts: DCFOptions = {}): DCFResult {
  const years = opts.projectionYears ?? 5;
  const g = opts.growthRate ?? 0.10;
  const tg = opts.terminalGrowthRate ?? 0.03;
  const wacc = opts.wacc ?? 0.08;

  const baseFCF = financials.freeCashFlow;

  if (!baseFCF || baseFCF <= 0 || !financials.marketCap) {
    const price = financials.price;
    const assumptions = 'DCF skipped — no positive free cash flow available. Using price ±15% as fair value range.';
    return {
      fairValue: price,
      fairValueLow: price * 0.85,
      fairValueHigh: price * 1.15,
      wacc,
      terminalGrowthRate: tg,
      projectionYears: years,
      projectedFCFs: [],
      assumptions,
    };
  }

  const sharesOutstanding = financials.marketCap / financials.price;
  const projectedFCFs: number[] = [];
  let pv = 0;

  for (let i = 1; i <= years; i++) {
    const fcf = baseFCF * Math.pow(1 + g, i);
    projectedFCFs.push(fcf);
    pv += fcf / Math.pow(1 + wacc, i);
  }

  const terminalFCF = projectedFCFs[years - 1] * (1 + tg);
  const terminalValue = terminalFCF / (wacc - tg);
  const pvTerminal = terminalValue / Math.pow(1 + wacc, years);

  const intrinsicValue = pv + pvTerminal;
  const fairValue = intrinsicValue / sharesOutstanding;
  const uncertainty = 0.10;

  return {
    fairValue,
    fairValueLow: fairValue * (1 - uncertainty),
    fairValueHigh: fairValue * (1 + uncertainty),
    wacc,
    terminalGrowthRate: tg,
    projectionYears: years,
    projectedFCFs,
    assumptions: `FCF growth: ${(g * 100).toFixed(0)}%, WACC: ${(wacc * 100).toFixed(1)}%, Terminal growth: ${(tg * 100).toFixed(1)}%`,
  };
}

export function calculateGraham(financials: StockFinancials): GrahamResult {
  const { eps, bookValue, price } = financials;

  if (!eps || eps <= 0 || !bookValue || bookValue <= 0) {
    return { grahamNumber: null, marginOfSafety: null, isUndervalued: false };
  }

  const grahamNumber = Math.sqrt(22.5 * eps * bookValue);
  const marginOfSafety = (grahamNumber - price) / price;

  return {
    grahamNumber,
    marginOfSafety,
    isUndervalued: grahamNumber > price,
  };
}

export function calculateRatios(financials: StockFinancials): RatioResult {
  const pb =
    financials.bookValue && financials.bookValue > 0 && financials.price
      ? financials.price / financials.bookValue
      : null;

  return {
    pe: financials.peRatio,
    forwardPE: financials.forwardPE,
    peg: financials.pegRatio,
    pb,
    roe: financials.roe,
    roa: financials.roa,
    debtToEquity: financials.debtToEquity,
    currentRatio: financials.currentRatio,
    operatingMargin: financials.operatingMargin,
    netMargin: financials.netMargin,
    revenueGrowth: financials.revenueGrowth,
    dividendYield: financials.dividendYield,
  };
}

export function fmt(n: number | null, suffix = '', decimals = 2): string {
  if (n === null) return 'N/A';
  return `${n.toFixed(decimals)}${suffix}`;
}

export function fmtPct(n: number | null): string {
  if (n === null) return 'N/A';
  return `${(n * 100).toFixed(1)}%`;
}

export function fmtBig(n: number | null): string {
  if (n === null) return 'N/A';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toFixed(0)}`;
}
