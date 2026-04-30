import {
  AltmanZResult,
  BeneishResult,
  DDMResult,
  DCFResult,
  EPVResult,
  EVMultiplesResult,
  GrahamResult,
  GrahamRevisedResult,
  InterestCoverageResult,
  PeterLynchResult,
  PiotroskiResult,
  PiotroskiSignals,
  RatioResult,
  ReverseDCFResult,
  RuleOf40Result,
  SortinoResult,
  StockFinancials,
} from '../types.js';

// ─── Formatting helpers ───────────────────────────────────────────────────────

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
  if (abs >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toFixed(0)}`;
}

// ─── 1. DCF ───────────────────────────────────────────────────────────────────

export interface DCFOptions {
  projectionYears?: number;
  growthRate?: number;
  terminalGrowthRate?: number;
  wacc?: number;
}

export function calculateDCF(financials: StockFinancials, opts: DCFOptions = {}): DCFResult {
  const years = opts.projectionYears ?? 5;
  const g  = opts.growthRate ?? 0.10;
  const tg = opts.terminalGrowthRate ?? 0.03;
  const wacc = opts.wacc ?? 0.08;
  const baseFCF = financials.freeCashFlow;

  if (!baseFCF || baseFCF <= 0 || !financials.marketCap) {
    const p = financials.price;
    return {
      fairValue: p, fairValueLow: p * 0.85, fairValueHigh: p * 1.15,
      wacc, terminalGrowthRate: tg, projectionYears: years, projectedFCFs: [],
      assumptions: 'DCF skipped — no positive FCF. Using price ±15%.',
    };
  }

  const shares = financials.sharesOutstanding ?? (financials.marketCap / financials.price);
  const projectedFCFs: number[] = [];
  let pv = 0;

  for (let i = 1; i <= years; i++) {
    const fcf = baseFCF * Math.pow(1 + g, i);
    projectedFCFs.push(fcf);
    pv += fcf / Math.pow(1 + wacc, i);
  }

  const tv = (projectedFCFs[years - 1] * (1 + tg)) / (wacc - tg);
  const pvTV = tv / Math.pow(1 + wacc, years);
  const fairValue = (pv + pvTV) / shares;

  return {
    fairValue,
    fairValueLow: fairValue * 0.90,
    fairValueHigh: fairValue * 1.10,
    wacc, terminalGrowthRate: tg, projectionYears: years, projectedFCFs,
    assumptions: `FCF growth ${(g * 100).toFixed(0)}% · WACC ${(wacc * 100).toFixed(1)}% · Terminal ${(tg * 100).toFixed(1)}%`,
  };
}

// ─── 2. Graham Number ────────────────────────────────────────────────────────

export function calculateGraham(financials: StockFinancials): GrahamResult {
  const { eps, bookValue, price } = financials;
  if (!eps || eps <= 0 || !bookValue || bookValue <= 0) {
    return { grahamNumber: null, marginOfSafety: null, isUndervalued: false };
  }
  const grahamNumber = Math.sqrt(22.5 * eps * bookValue);
  const marginOfSafety = (grahamNumber - price) / price;
  return { grahamNumber, marginOfSafety, isUndervalued: grahamNumber > price };
}

// ─── 3. Key Ratios ───────────────────────────────────────────────────────────

export function calculateRatios(financials: StockFinancials): RatioResult {
  const pb =
    financials.bookValue && financials.bookValue > 0
      ? financials.price / financials.bookValue
      : null;
  return {
    pe: financials.peRatio, forwardPE: financials.forwardPE, peg: financials.pegRatio, pb,
    roe: financials.roe, roa: financials.roa, debtToEquity: financials.debtToEquity,
    currentRatio: financials.currentRatio, operatingMargin: financials.operatingMargin,
    netMargin: financials.netMargin, revenueGrowth: financials.revenueGrowth,
    dividendYield: financials.dividendYield,
  };
}

// ─── 4. Reverse DCF ──────────────────────────────────────────────────────────

export function calculateReverseDCF(financials: StockFinancials): ReverseDCFResult {
  const wacc = 0.08;
  const tg   = 0.03;
  const years = 5;
  const fcf = financials.freeCashFlow;
  const price = financials.price;
  const shares = financials.sharesOutstanding ?? (financials.marketCap / price);

  if (!fcf || fcf <= 0 || !shares || shares <= 0) {
    return { impliedGrowthRate: null, wacc, terminalGrowthRate: tg, years, isPossible: false,
      interpretation: 'Not calculable — requires positive free cash flow.' };
  }

  const targetValue = price * shares;

  function dcfAt(g: number): number {
    let pv = 0;
    for (let i = 1; i <= years; i++) pv += fcf! * Math.pow(1 + g, i) / Math.pow(1 + wacc, i);
    const tv = (fcf! * Math.pow(1 + g, years) * (1 + tg)) / (wacc - tg);
    return pv + tv / Math.pow(1 + wacc, years);
  }

  // Binary search
  let lo = -0.50, hi = 2.00;
  if (dcfAt(lo) > targetValue) {
    return { impliedGrowthRate: lo, wacc, terminalGrowthRate: tg, years, isPossible: true,
      interpretation: `Market implies negative FCF growth (<${(lo * 100).toFixed(0)}%) — deeply discounted.` };
  }
  if (dcfAt(hi) < targetValue) {
    return { impliedGrowthRate: hi, wacc, terminalGrowthRate: tg, years, isPossible: true,
      interpretation: `Market implies >200% FCF growth — extremely growth-dependent valuation.` };
  }
  for (let iter = 0; iter < 80; iter++) {
    const mid = (lo + hi) / 2;
    if (dcfAt(mid) < targetValue) lo = mid; else hi = mid;
    if (hi - lo < 1e-5) break;
  }

  const g = (lo + hi) / 2;
  const gPct = g * 100;
  const interpretation =
    gPct < 0   ? `Market prices in FCF decline of ${Math.abs(gPct).toFixed(1)}%/yr — very bearish.` :
    gPct < 5   ? `Market prices in ${gPct.toFixed(1)}%/yr FCF growth — conservative expectation.` :
    gPct < 15  ? `Market prices in ${gPct.toFixed(1)}%/yr FCF growth — moderate growth expected.` :
    gPct < 30  ? `Market prices in ${gPct.toFixed(1)}%/yr FCF growth — high growth priced in.` :
                 `Market prices in ${gPct.toFixed(1)}%/yr FCF growth — extreme growth required.`;

  return { impliedGrowthRate: g, wacc, terminalGrowthRate: tg, years, isPossible: true, interpretation };
}

// ─── 5. Peter Lynch Fair Value ────────────────────────────────────────────────

export function calculatePeterLynch(financials: StockFinancials): PeterLynchResult {
  const eps = financials.eps;
  // Prefer 3-year EPS CAGR from Finnhub (more stable than trailing 1-year)
  const g   = financials.epsGrowth3Y ?? financials.earningsGrowth ?? financials.revenueGrowth;
  const dy  = financials.dividendYield ?? 0;
  const price = financials.price;

  if (!eps || eps <= 0 || !g) {
    return { fairValue: null, fairValueWithDividend: null, growthRate: null,
             isUndervalued: null, marginOfSafety: null };
  }

  const gPct = g * 100;
  const fairValue = eps * gPct;
  const fairValueWithDividend = eps * (gPct + dy * 100);
  const marginOfSafety = (fairValue - price) / price;

  return {
    fairValue,
    fairValueWithDividend,
    growthRate: g,
    isUndervalued: fairValue > price,
    marginOfSafety,
  };
}

// ─── 6. EV Multiples ─────────────────────────────────────────────────────────

export function calculateEVMultiples(financials: StockFinancials): EVMultiplesResult {
  const ev  = financials.enterpriseValue;
  const ebitda = financials.ebitda;
  const rev = financials.revenue;
  const fcf = financials.freeCashFlow;
  const mc  = financials.marketCap;

  return {
    enterpriseValue: ev,
    evToEbitda: ev && ebitda && ebitda > 0 ? ev / ebitda : null,
    evToRevenue: ev && rev && rev > 0       ? ev / rev   : null,
    evToFCF:    ev && fcf && fcf > 0        ? ev / fcf   : null,
    priceToFCF: mc && fcf && fcf > 0        ? mc / fcf   : null,
    priceToSales: mc && rev && rev > 0      ? mc / rev   : null,
  };
}

// ─── 7. Rule of 40 ───────────────────────────────────────────────────────────

export function calculateRuleOf40(financials: StockFinancials): RuleOf40Result {
  const rg = financials.revenueGrowth;
  const pm = financials.operatingMargin ?? financials.netMargin;

  if (rg === null || pm === null) {
    return { score: null, revenueGrowthPct: null, profitMarginPct: null, passes: null };
  }

  const rgPct = rg * 100;
  const pmPct = pm * 100;
  const score = rgPct + pmPct;

  return { score, revenueGrowthPct: rgPct, profitMarginPct: pmPct, passes: score >= 40 };
}

// ─── 8. Revised Graham Formula ───────────────────────────────────────────────

// Graham's revised formula: V* = EPS × (8.5 + 2g) × 4.4 / Y
// g = annual EPS growth rate (%), Y = current AAA bond yield
const AAA_BOND_YIELD = 5.0; // ~current rate, update as needed

export function calculateGrahamRevised(
  financials: StockFinancials,
  bondYield = AAA_BOND_YIELD,
): GrahamRevisedResult {
  const eps = financials.eps;
  const g   = financials.earningsGrowth ?? financials.revenueGrowth;
  const price = financials.price;

  if (!eps || eps <= 0 || !g) {
    return { fairValue: null, bondYield, growthRate: null,
             marginOfSafety: null, isUndervalued: null };
  }

  const gPct = g * 100;
  const fairValue = (eps * (8.5 + 2 * gPct) * 4.4) / bondYield;
  const marginOfSafety = (fairValue - price) / price;

  return { fairValue, bondYield, growthRate: g, marginOfSafety, isUndervalued: fairValue > price };
}

// ─── 9. Piotroski F-Score ────────────────────────────────────────────────────

export function calculatePiotroski(financials: StockFinancials): PiotroskiResult {
  const f = financials;
  const py = f.prevYear;

  // Profitability
  const f1 = f.roa !== null ? f.roa > 0 : null;
  const f2 = f.operatingCashFlow !== null ? f.operatingCashFlow > 0 : null;

  // F3: ROA improving — compare TTM ROA vs prior year (netIncome/totalAssets)
  const prevROA = py?.netIncome && py?.totalAssets && py.totalAssets > 0
    ? py.netIncome / py.totalAssets : null;
  const f3 = f.roa !== null && prevROA !== null ? f.roa > prevROA : null;

  // F4: Accruals — CFO/Assets > ROA (quality of earnings)
  const cfRoa = f.operatingCashFlow !== null && f.totalAssets && f.totalAssets > 0
    ? f.operatingCashFlow / f.totalAssets : null;
  const f4 = cfRoa !== null && f.roa !== null ? cfRoa > f.roa : null;

  // Leverage / Liquidity
  const currLeverage = f.longTermDebt !== null && f.totalAssets && f.totalAssets > 0
    ? f.longTermDebt / f.totalAssets : null;
  const prevLeverage = py?.longTermDebt !== null && py?.totalAssets && py?.totalAssets && py.totalAssets > 0
    ? py.longTermDebt! / py.totalAssets : null;
  const f5 = currLeverage !== null && prevLeverage !== null ? currLeverage < prevLeverage : null;

  const currCR = f.currentRatio;
  const prevCR = py?.currentAssets && py?.currentLiabilities && py.currentLiabilities > 0
    ? py.currentAssets / py.currentLiabilities : null;
  const f6 = currCR !== null && prevCR !== null ? currCR > prevCR : null;

  // F7: No new shares — not reliably available, skip
  const f7: boolean | null = null;

  // Efficiency
  const currGM = f.grossProfit && f.revenue && f.revenue > 0 ? f.grossProfit / f.revenue : null;
  const prevGM = py?.grossProfit && py?.revenue && py.revenue > 0 ? py.grossProfit / py.revenue : null;
  const f8 = currGM !== null && prevGM !== null ? currGM > prevGM : null;

  const currAT = f.revenue && f.totalAssets && f.totalAssets > 0 ? f.revenue / f.totalAssets : null;
  const prevAT = py?.revenue && py?.totalAssets && py.totalAssets > 0 ? py.revenue / py.totalAssets : null;
  const f9 = currAT !== null && prevAT !== null ? currAT > prevAT : null;

  const signals: PiotroskiSignals = {
    f1_positiveROA: f1,
    f2_positiveCFO: f2,
    f3_improvingROA: f3,
    f4_accruals: f4,
    f5_reducingLeverage: f5,
    f6_improvingLiquidity: f6,
    f7_noNewShares: f7,
    f8_improvingGrossMargin: f8,
    f9_improvingAssetTurnover: f9,
  };

  const values = [f1, f2, f3, f4, f5, f6, f7, f8, f9];
  const scored = values.filter((v) => v !== null);
  const score  = scored.filter(Boolean).length;
  const maxScore = scored.length;

  const interpretation: PiotroskiResult['interpretation'] =
    score >= Math.ceil(maxScore * 0.75) ? 'strong' :
    score <= Math.floor(maxScore * 0.33) ? 'weak' : 'neutral';

  return { score, maxScore, signals, interpretation };
}

// ─── 10. Altman Z-Score ──────────────────────────────────────────────────────

export function calculateAltmanZ(financials: StockFinancials): AltmanZResult {
  const f = financials;

  // Determine model: use modified Z' for service/tech companies
  const manufacturingSectors = ['Basic Materials', 'Industrials', 'Energy', 'Utilities', 'Consumer Cyclical'];
  const isManufacturing = f.sector && manufacturingSectors.includes(f.sector);
  const model: AltmanZResult['model'] = isManufacturing ? 'original' : 'modified';

  const ta = f.totalAssets;
  const wc = f.workingCapital;
  const re = f.retainedEarnings;
  const ebit = f.ebit;
  const tl = f.totalLiabilities;
  const rev = f.revenue;
  const mc = f.marketCap;

  if (!ta || ta <= 0) {
    return { score: null, zone: 'unknown', x1: null, x2: null, x3: null, x4: null, x5: null,
             model, thresholds: { safe: 2.99, distress: 1.81 } };
  }

  const x1 = wc !== null ? wc / ta : null;
  const x2 = re !== null ? re / ta : null;
  const x3 = ebit !== null ? ebit / ta : null;
  const x4 = tl && tl > 0 && mc ? mc / tl : null;
  const x5 = rev ? rev / ta : null;

  let score: number | null = null;
  let thresholds: AltmanZResult['thresholds'];

  if (model === 'original') {
    // Original Z: Z = 1.2*X1 + 1.4*X2 + 3.3*X3 + 0.6*X4 + 1.0*X5
    thresholds = { safe: 2.99, distress: 1.81 };
    if (x1 !== null && x2 !== null && x3 !== null && x4 !== null && x5 !== null) {
      score = 1.2 * x1 + 1.4 * x2 + 3.3 * x3 + 0.6 * x4 + 1.0 * x5;
    }
  } else {
    // Modified Z': Z' = 6.56*X1 + 3.26*X2 + 6.72*X3 + 1.05*X4  (no X5)
    thresholds = { safe: 2.60, distress: 1.11 };
    if (x1 !== null && x2 !== null && x3 !== null && x4 !== null) {
      score = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4;
    }
  }

  const zone: AltmanZResult['zone'] =
    score === null          ? 'unknown' :
    score > thresholds.safe ? 'safe'    :
    score < thresholds.distress ? 'distress' : 'grey';

  return { score, zone, x1, x2, x3, x4, x5, model, thresholds };
}

// ─── 11. Dividend Discount Model ─────────────────────────────────────────────

export function calculateDDM(financials: StockFinancials, riskFreeRate = 0.045): DDMResult {
  const dy   = financials.dividendYield;
  const beta = financials.beta ?? 1.0;
  const price = financials.price;

  if (!dy || dy <= 0) {
    return { fairValue: null, dividendPerShare: null, dividendGrowthRate: null,
             requiredReturn: null, isApplicable: false };
  }

  const dividendPerShare = price * dy;
  // CAPM: r = risk-free + beta × equity premium
  const riskFree = riskFreeRate;
  const equityPremium = 0.055;
  const requiredReturn = riskFree + beta * equityPremium;

  // Dividend growth: prefer 5-year historical from Finnhub, else estimate via sustainable growth
  const retentionRatio = financials.payoutRatio !== null ? 1 - financials.payoutRatio : 0.5;
  const roe = financials.roe ?? 0.10;
  const sustainableGrowth = roe * retentionRatio;
  const eg = financials.dividendGrowthRate5Y ?? financials.earningsGrowth ?? sustainableGrowth;
  const dividendGrowthRate = Math.min(eg, requiredReturn - 0.01, 0.12);

  if (dividendGrowthRate >= requiredReturn) {
    return { fairValue: null, dividendPerShare, dividendGrowthRate, requiredReturn, isApplicable: true };
  }

  // Gordon Growth Model: P = D1 / (r - g)
  const d1 = dividendPerShare * (1 + dividendGrowthRate);
  const fairValue = d1 / (requiredReturn - dividendGrowthRate);

  return { fairValue, dividendPerShare, dividendGrowthRate, requiredReturn, isApplicable: true };
}

// ─── 12. Earnings Power Value (Greenwald) ────────────────────────────────────

export function calculateEPV(financials: StockFinancials): EPVResult {
  const wacc = 0.08;
  const ebit = financials.ebit;
  const taxRate = financials.taxRate ?? 0.21;
  const price = financials.price;
  const shares = financials.sharesOutstanding ?? (financials.marketCap / price);

  if (!ebit || ebit <= 0 || !shares || shares <= 0) {
    return { fairValue: null, normalizedEbit: null, taxRate, wacc, marginOfSafety: null };
  }

  // Normalize EBIT by adding back D&A and subtracting maintenance capex
  // Maintenance capex ≈ depreciation (simplified)
  const depreciation = financials.depreciation ?? 0;
  const normalizedEbit = ebit + depreciation * 0.2; // slight normalization

  const nopat = normalizedEbit * (1 - taxRate);
  const epv   = nopat / wacc;

  // Add cash, subtract debt for equity value
  const cash = financials.totalCash ?? 0;
  const debt = financials.totalDebt ?? 0;
  const equityValue = epv + cash - debt;
  const fairValue = equityValue / shares;

  const marginOfSafety = (fairValue - price) / price;

  return { fairValue, normalizedEbit, taxRate, wacc, marginOfSafety };
}

// ─── 13. Sortino Ratio ───────────────────────────────────────────────────────

const FALLBACK_RFR = 0.045;

export function calculateSortino(financials: StockFinancials, riskFreeRate = FALLBACK_RFR): SortinoResult {
  const returns = financials.monthlyReturns ?? [];
  const unknown: SortinoResult = {
    ratio: null, annualReturn: null, downsideDeviation: null,
    riskFreeRate, interpretation: 'unknown',
  };

  if (returns.length < 6) return unknown;

  const annualReturn = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;

  const monthlyRfr = riskFreeRate / 12;
  const negativeExcess = returns.map((r) => Math.min(r - monthlyRfr, 0));
  const meanSquared = negativeExcess.reduce((s, r) => s + r * r, 0) / negativeExcess.length;
  const downsideDeviation = Math.sqrt(meanSquared) * Math.sqrt(12); // annualised

  if (downsideDeviation === 0) return unknown;

  const ratio = (annualReturn - riskFreeRate) / downsideDeviation;

  const interpretation: SortinoResult['interpretation'] =
    ratio >= 2   ? 'excellent'   :
    ratio >= 1   ? 'good'        :
    ratio >= 0.5 ? 'acceptable'  :
    ratio >= 0   ? 'poor'        :
                   'very poor';

  return { ratio, annualReturn, downsideDeviation, riskFreeRate, interpretation };
}

// ─── 14. Beneish M-Score ─────────────────────────────────────────────────────

export function calculateBeneish(financials: StockFinancials): BeneishResult {
  const f  = financials;
  const py = f.prevYear;

  const unknown: BeneishResult = {
    score: null, probability: 'unknown',
    dsri: null, gmi: null, aqi: null, sgi: null,
    depi: null, sgai: null, tata: null, lvgi: null,
    variablesComputed: 0,
  };

  if (!py || !f.totalAssets || f.totalAssets <= 0) return unknown;

  // GMI — Gross Margin Index (available: grossProfit, revenue both years)
  const gm0 = py.revenue && py.revenue > 0 && py.grossProfit !== null ? py.grossProfit / py.revenue : null;
  const gm1 = f.revenue && f.revenue > 0 && f.grossProfit !== null ? f.grossProfit / f.revenue : null;
  const gmi = gm0 !== null && gm1 !== null && gm1 > 0 ? gm0 / gm1 : null;

  // SGI — Sales Growth Index
  const sgi = py.revenue && py.revenue > 0 && f.revenue ? f.revenue / py.revenue : null;

  // TATA — Total Accruals to Total Assets
  const tata = f.netIncome !== null && f.operatingCashFlow !== null
    ? (f.netIncome - f.operatingCashFlow) / f.totalAssets
    : null;

  // LVGI — Leverage Index
  const lev1 = f.longTermDebt !== null && f.totalCurrentLiabilities !== null
    ? (f.longTermDebt + f.totalCurrentLiabilities) / f.totalAssets : null;
  const lev0 = py.longTermDebt !== null && py.currentLiabilities !== null && py.totalAssets && py.totalAssets > 0
    ? (py.longTermDebt + py.currentLiabilities) / py.totalAssets : null;
  const lvgi = lev1 !== null && lev0 !== null && lev0 > 0 ? lev1 / lev0 : null;

  // DSRI — Days Sales Receivable Index (needs receivables)
  const dsr1 = f.receivables !== null && f.revenue && f.revenue > 0 ? f.receivables / f.revenue : null;
  const dsr0 = py.receivables !== null && py.revenue && py.revenue > 0 ? py.receivables / py.revenue : null;
  const dsri = dsr1 !== null && dsr0 !== null && dsr0 > 0 ? dsr1 / dsr0 : null;

  // AQI — Asset Quality Index (needs PPE)
  const aq1 = f.ppe !== null && f.totalCurrentAssets !== null
    ? 1 - (f.totalCurrentAssets + f.ppe) / f.totalAssets : null;
  const aq0 = py.ppe !== null && py.currentAssets !== null && py.totalAssets && py.totalAssets > 0
    ? 1 - (py.currentAssets + py.ppe) / py.totalAssets : null;
  const aqi = aq1 !== null && aq0 !== null && aq0 > 0 ? aq1 / aq0 : null;

  // DEPI — Depreciation Index (needs PPE + depreciation both years)
  const dep1 = f.depreciation;
  const dep0 = py.depreciation;
  const depi = dep1 !== null && dep0 !== null && f.ppe !== null && py.ppe !== null
    && (f.ppe + dep1) > 0 && (py.ppe + dep0) > 0
    ? (dep0 / (py.ppe + dep0)) / (dep1 / (f.ppe + dep1))
    : null;

  // SGAI — SG&A Index (needs SGA)
  const sgai1 = f.sga !== null && f.revenue && f.revenue > 0 ? f.sga / f.revenue : null;
  const sgai0 = py.sga !== null && py.revenue && py.revenue > 0 ? py.sga / py.revenue : null;
  const sgai = sgai1 !== null && sgai0 !== null && sgai0 > 0 ? sgai1 / sgai0 : null;

  // Use 1.0 (neutral) for missing indices
  const v = (x: number | null) => x ?? 1.0;
  const computed = [dsri, gmi, aqi, sgi, depi, sgai, tata, lvgi].filter((x) => x !== null).length;

  const score =
    -4.84
    + 0.920 * v(dsri)
    + 0.528 * v(gmi)
    + 0.404 * v(aqi)
    + 0.892 * v(sgi)
    + 0.115 * v(depi)
    - 0.172 * v(sgai)
    + 4.679 * v(tata)
    - 0.327 * v(lvgi);

  const probability: BeneishResult['probability'] =
    score > -1.78  ? 'likely manipulator'   :
    score > -2.22  ? 'grey zone'            :
                     'unlikely manipulator';

  return { score, probability, dsri, gmi, aqi, sgi, depi, sgai, tata, lvgi, variablesComputed: computed };
}

// ─── 15. Interest Coverage ───────────────────────────────────────────────────

export function calculateInterestCoverage(financials: StockFinancials): InterestCoverageResult {
  const ebit = financials.ebit;
  const interest = financials.interestExpense;

  if (!ebit || !interest || interest === 0) {
    // No interest expense = debt-free = excellent
    if (ebit && (!interest || interest === 0)) {
      return { ratio: null, interpretation: 'excellent' };
    }
    return { ratio: null, interpretation: 'unknown' };
  }

  const absInterest = Math.abs(interest);
  const ratio = ebit / absInterest;

  const interpretation: InterestCoverageResult['interpretation'] =
    ratio >= 8   ? 'excellent' :
    ratio >= 4   ? 'good'      :
    ratio >= 2   ? 'fair'      :
    ratio >= 1   ? 'poor'      :
                   'critical';

  return { ratio, interpretation };
}
