import {
  AltmanZResult,
  BeneishResult,
  CompositeContributor,
  CompositeExclusion,
  CompositeFairValueResult,
  CompositeTier,
  DDMResult,
  DCFResult,
  EPVResult,
  EVMultiplesResult,
  GrahamResult,
  GrahamRevisedResult,
  InterestCoverageResult,
  NCAVResult,
  PeerMultiplesEntry,
  PeerMultiplesResult,
  PeterLynchResult,
  PiotroskiResult,
  PiotroskiSignals,
  RatioResult,
  ReverseDCFResult,
  RIMResult,
  RuleOf40Result,
  SectorMedians,
  SortinoResult,
  StockFinancials,
} from '../types.js';
import { MarketRates } from '../data/fred.js';

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

// ─── Shared constants & helpers ──────────────────────────────────────────────

const ERP = 0.055; // Damodaran-style mature-market equity risk premium
const FALLBACK_RFR = 0.045;
const FALLBACK_AAA = 0.05; // decimal (5%)
const TERMINAL_GROWTH_DEFAULT = 0.03;

/**
 * CAPM cost of equity with SWS-style β floor 0.8 / cap 2.0 to neutralise
 * stale-data outliers and volatility spikes.
 */
function costOfEquity(beta: number | null, riskFreeRate: number): number {
  const b = Math.max(0.8, Math.min(beta ?? 1.0, 2.0));
  return riskFreeRate + b * ERP;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
}

function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

/**
 * Stage-1 growth for DCF. Priority:
 *   1. Mean of analyst forward EPS growth (+0y and +1y) — most market-aligned;
 *      cap at 60% (Damodaran's "extreme growth" boundary for firms in transition)
 *   2. 3Y EPS CAGR — historical proxy for growth firms with sparse coverage;
 *      cap at 30% (tighter — historical can be noisy / regression-prone)
 *   3. Earnings / revenue growth — last resort, cap at 30%
 *
 * Higher cap for forward analyst is intentional: analysts have visibility into
 * pipeline, contracts, and capacity. Historical CAGR is rear-view-only and
 * deserves more skepticism.
 */
/**
 * Sanity check: a model's fair value is plausible only if it sits in
 * [price × 0.02, price × 30]. Outside that range almost always signals a
 * data-quality issue rather than a real valuation insight — most commonly
 * dual-class share unit mismatches (e.g., Yahoo reports BRK-A book value
 * for BRK-B shares, making BV-based models explode by 100×–1000×).
 *
 * The bounds are deliberately wide: a legitimately pessimistic model output
 * (e.g., RIM saying a buyback-heavy firm with tiny book value is worth $13
 * when it trades at $287) should pass through — that's signal, not noise.
 * Only filter clear unit/data anomalies.
 */
function isPlausibleFairValue(fv: number | null | undefined, price: number): boolean {
  if (fv === null || fv === undefined || !Number.isFinite(fv) || fv <= 0) return false;
  if (!Number.isFinite(price) || price <= 0) return false;
  const r = fv / price;
  return r >= 0.02 && r <= 30;
}

function deriveStage1Growth(f: StockFinancials): number {
  const fwd = (f.earningsEstimates ?? [])
    .filter((e) => (e.period === '+0y' || e.period === '+1y') && e.epsGrowth !== null && e.epsGrowth > 0)
    .map((e) => e.epsGrowth!);

  if (fwd.length > 0) {
    const mean = fwd.reduce((s, v) => s + v, 0) / fwd.length;
    return Math.max(0, Math.min(mean, 0.60));
  }
  const raw = f.epsGrowth3Y ?? f.earningsGrowth ?? f.revenueGrowth ?? 0.08;
  return Math.max(0, Math.min(raw, 0.30));
}

/** Forward analyst EPS growth (mean of +0y and +1y) when available. */
function forwardEpsGrowth(f: StockFinancials): number | null {
  const fwd = (f.earningsEstimates ?? [])
    .filter((e) => (e.period === '+0y' || e.period === '+1y') && e.epsGrowth !== null && e.epsGrowth > 0)
    .map((e) => e.epsGrowth!);
  if (fwd.length === 0) return null;
  return fwd.reduce((s, v) => s + v, 0) / fwd.length;
}

function getShares(f: StockFinancials): number {
  return f.sharesOutstanding ?? (f.marketCap / f.price);
}

// ─── 1. Two-Stage DCF (replaces single-stage) ────────────────────────────────

export interface DCFOptions {
  stage1Years?: number;       // default 5
  fadeYears?: number;         // default 5
  growthRate?: number;        // stage-1 growth (decimal); auto-derived if absent
  terminalGrowthRate?: number;
}

/** Project FCFs over (stage1 + fade) years with linear growth fade. */
function projectFCFs(
  baseFCF: number,
  stage1G: number,
  terminalG: number,
  stage1Years: number,
  fadeYears: number,
): number[] {
  const fcfs: number[] = [];
  let prev = baseFCF;
  for (let i = 1; i <= stage1Years; i++) {
    prev = prev * (1 + stage1G);
    fcfs.push(prev);
  }
  for (let j = 1; j <= fadeYears; j++) {
    const g = stage1G - (stage1G - terminalG) * (j / fadeYears);
    prev = prev * (1 + g);
    fcfs.push(prev);
  }
  return fcfs;
}

/** Sum of PV(FCFs) + PV(terminal). Equity bridge applied separately by caller. */
function discountToEV(
  fcfs: number[],
  terminalG: number,
  discountRate: number,
): { enterpriseValue: number; terminalValue: number } {
  let pv = 0;
  for (let t = 0; t < fcfs.length; t++) {
    pv += fcfs[t] / Math.pow(1 + discountRate, t + 1);
  }
  const lastFCF = fcfs[fcfs.length - 1];
  // Terminal must satisfy r > g_terminal; caller must validate.
  const tv = (lastFCF * (1 + terminalG)) / (discountRate - terminalG);
  const pvTV = tv / Math.pow(1 + discountRate, fcfs.length);
  return { enterpriseValue: pv + pvTV, terminalValue: tv };
}

export function calculateDCF(
  financials: StockFinancials,
  marketRates?: MarketRates,
  opts: DCFOptions = {},
): DCFResult {
  const stage1Years = opts.stage1Years ?? 5;
  const fadeYears   = opts.fadeYears ?? 5;
  const baseG       = opts.growthRate ?? deriveStage1Growth(financials);
  const terminalG   = opts.terminalGrowthRate ?? TERMINAL_GROWTH_DEFAULT;
  const rfr         = marketRates?.riskFreeRate ?? FALLBACK_RFR;
  const r           = costOfEquity(financials.beta, rfr);

  const baseFCF = financials.freeCashFlow;
  const shares  = getShares(financials);
  const cash    = financials.totalCash ?? 0;
  const debt    = financials.totalDebt ?? 0;
  const netDebt = debt - cash;

  const empty = (note: string): DCFResult => ({
    fairValue: null, fairValueBear: null, fairValueBull: null,
    discountRate: r, beta: financials.beta, riskFreeRate: rfr,
    stage1Growth: baseG, terminalGrowthRate: terminalG,
    stage1Years, fadeYears,
    projectedFCFs: [], terminalValue: null, enterpriseValue: null, netDebt,
    assumptions: note,
  });

  if (!baseFCF || baseFCF <= 0) {
    return empty('DCF not applicable — requires positive free cash flow.');
  }
  if (r <= terminalG) {
    return empty(`DCF not stable — discount rate ${(r * 100).toFixed(1)}% ≤ terminal growth ${(terminalG * 100).toFixed(1)}%.`);
  }

  const baseFCFs   = projectFCFs(baseFCF, baseG, terminalG, stage1Years, fadeYears);
  const baseValue  = discountToEV(baseFCFs, terminalG, r);
  const baseEquity = baseValue.enterpriseValue - netDebt;
  const baseFV     = baseEquity / shares;

  // Bear: stage-1 growth × 0.5 (floored at terminal+1pp), discount rate +2pp
  const bearG  = Math.max(terminalG + 0.01, baseG * 0.5);
  const bearR  = r + 0.02;
  const bearFCFs = projectFCFs(baseFCF, bearG, terminalG, stage1Years, fadeYears);
  const bearVal  = discountToEV(bearFCFs, terminalG, bearR);
  const bearFV   = (bearVal.enterpriseValue - netDebt) / shares;

  // Bull: stage-1 growth × 1.5 (capped at 75% absolute), discount rate −2pp (clamp r > g_t + 1pp)
  const bullG  = Math.min(0.75, baseG * 1.5);
  const bullR  = Math.max(terminalG + 0.01, r - 0.02);
  const bullFCFs = projectFCFs(baseFCF, bullG, terminalG, stage1Years, fadeYears);
  const bullVal  = discountToEV(bullFCFs, terminalG, bullR);
  const bullFV   = (bullVal.enterpriseValue - netDebt) / shares;

  const assumptions = `Stage-1 ${(baseG * 100).toFixed(1)}% × ${stage1Years}y → fade × ${fadeYears}y → terminal ${(terminalG * 100).toFixed(1)}% · CAPM r ${(r * 100).toFixed(1)}% (β ${financials.beta?.toFixed(2) ?? '1.0'} capped, rfr ${(rfr * 100).toFixed(1)}%, ERP ${(ERP * 100).toFixed(1)}%)`;

  if (!isPlausibleFairValue(baseFV, financials.price)) {
    return empty(`DCF base value implausible vs price — likely a per-share data anomaly.`);
  }

  return {
    fairValue: baseFV,
    fairValueBear: isPlausibleFairValue(bearFV, financials.price) ? bearFV : null,
    fairValueBull: isPlausibleFairValue(bullFV, financials.price) ? bullFV : null,
    discountRate: r,
    beta: financials.beta,
    riskFreeRate: rfr,
    stage1Growth: baseG,
    terminalGrowthRate: terminalG,
    stage1Years, fadeYears,
    projectedFCFs: baseFCFs,
    terminalValue: baseValue.terminalValue,
    enterpriseValue: baseValue.enterpriseValue,
    netDebt,
    assumptions,
  };
}

// ─── 2. Graham Number ────────────────────────────────────────────────────────

export function calculateGraham(financials: StockFinancials): GrahamResult {
  const { eps, bookValue, price } = financials;
  if (!eps || eps <= 0 || !bookValue || bookValue <= 0) {
    return { grahamNumber: null, marginOfSafety: null, isUndervalued: false };
  }
  const grahamNumber = Math.sqrt(22.5 * eps * bookValue);
  if (!isPlausibleFairValue(grahamNumber, price)) {
    // Outlier — usually a per-share unit mismatch (e.g., dual-class shares).
    return { grahamNumber: null, marginOfSafety: null, isUndervalued: false };
  }
  const marginOfSafety = (grahamNumber - price) / price;
  return { grahamNumber, marginOfSafety, isUndervalued: grahamNumber > price };
}

// ─── 3. Key Ratios (incl. Owner Earnings Yield) ──────────────────────────────

export function calculateRatios(financials: StockFinancials): RatioResult {
  const pb =
    financials.bookValue && financials.bookValue > 0
      ? financials.price / financials.bookValue
      : null;

  // Owner Earnings (Buffett): NI + D&A − maintenance CapEx (≈ CapEx as proxy)
  const ni    = financials.netIncome;
  const dep   = financials.depreciation;
  const capex = financials.capex;
  const mc    = financials.marketCap;
  const oe = (ni !== null && dep !== null && capex !== null)
    ? ni + dep - Math.abs(capex)
    : null;
  const ownerEarningsYield = oe !== null && mc > 0 ? oe / mc : null;

  return {
    pe: financials.peRatio, forwardPE: financials.forwardPE, peg: financials.pegRatio, pb,
    roe: financials.roe, roa: financials.roa, debtToEquity: financials.debtToEquity,
    currentRatio: financials.currentRatio, operatingMargin: financials.operatingMargin,
    netMargin: financials.netMargin, revenueGrowth: financials.revenueGrowth,
    dividendYield: financials.dividendYield,
    ownerEarningsYield,
  };
}

// ─── 4. Reverse DCF (uses 2-stage projection) ────────────────────────────────

export function calculateReverseDCF(
  financials: StockFinancials,
  marketRates?: MarketRates,
): ReverseDCFResult {
  const stage1Years = 5;
  const fadeYears = 5;
  const terminalG = TERMINAL_GROWTH_DEFAULT;
  const rfr = marketRates?.riskFreeRate ?? FALLBACK_RFR;
  const r   = costOfEquity(financials.beta, rfr);

  const fcf    = financials.freeCashFlow;
  const price  = financials.price;
  const shares = getShares(financials);
  const cash   = financials.totalCash ?? 0;
  const debt   = financials.totalDebt ?? 0;
  const netDebt = debt - cash;

  if (!fcf || fcf <= 0 || !shares || shares <= 0 || r <= terminalG) {
    return {
      impliedGrowthRate: null, discountRate: r, terminalGrowthRate: terminalG,
      stage1Years, fadeYears, isPossible: false,
      interpretation: 'Not calculable — requires positive free cash flow and r > terminal g.',
    };
  }

  // Solve for stage-1 g such that EV(g) = market EV (= price × shares + net debt)
  const targetEV = price * shares + netDebt;

  const evAt = (g: number): number => {
    const fcfs = projectFCFs(fcf, g, terminalG, stage1Years, fadeYears);
    return discountToEV(fcfs, terminalG, r).enterpriseValue;
  };

  const lo0 = -0.50, hi0 = 1.50;
  if (evAt(lo0) > targetEV) {
    return {
      impliedGrowthRate: lo0, discountRate: r, terminalGrowthRate: terminalG,
      stage1Years, fadeYears, isPossible: true,
      interpretation: `Market implies FCF decline beyond ${(lo0 * 100).toFixed(0)}%/yr — extreme distress pricing.`,
    };
  }
  if (evAt(hi0) < targetEV) {
    return {
      impliedGrowthRate: hi0, discountRate: r, terminalGrowthRate: terminalG,
      stage1Years, fadeYears, isPossible: true,
      interpretation: `Market implies >${(hi0 * 100).toFixed(0)}%/yr stage-1 FCF growth — extreme growth pricing.`,
    };
  }

  let lo = lo0, hi = hi0;
  for (let iter = 0; iter < 80; iter++) {
    const mid = (lo + hi) / 2;
    if (evAt(mid) < targetEV) lo = mid; else hi = mid;
    if (hi - lo < 1e-5) break;
  }
  const g = (lo + hi) / 2;
  const gPct = g * 100;
  const interpretation =
    gPct < 0   ? `Market prices in stage-1 FCF decline of ${Math.abs(gPct).toFixed(1)}%/yr — bearish.` :
    gPct < 5   ? `Market prices in ${gPct.toFixed(1)}%/yr stage-1 FCF growth — conservative.` :
    gPct < 15  ? `Market prices in ${gPct.toFixed(1)}%/yr stage-1 FCF growth — moderate.` :
    gPct < 30  ? `Market prices in ${gPct.toFixed(1)}%/yr stage-1 FCF growth — high growth priced in.` :
                 `Market prices in ${gPct.toFixed(1)}%/yr stage-1 FCF growth — extreme growth required.`;

  return {
    impliedGrowthRate: g,
    discountRate: r,
    terminalGrowthRate: terminalG,
    stage1Years, fadeYears,
    isPossible: true,
    interpretation,
  };
}

// ─── 5. Peter Lynch Fair Value ────────────────────────────────────────────────

export function calculatePeterLynch(financials: StockFinancials): PeterLynchResult {
  const eps = financials.eps;
  // Lynch fair value = EPS × growth%. Prefer forward analyst (Lynch's own examples
  // explicitly used analyst forecasts for "tenbaggers"); fall back to historical CAGR.
  const g   = forwardEpsGrowth(financials)
              ?? financials.epsGrowth3Y
              ?? financials.earningsGrowth
              ?? financials.revenueGrowth;
  const dy  = financials.dividendYield ?? 0;
  const price = financials.price;

  if (!eps || eps <= 0 || !g) {
    return { fairValue: null, fairValueWithDividend: null, growthRate: null,
             isUndervalued: null, marginOfSafety: null };
  }

  const gPct = g * 100;
  if (gPct <= 0) {
    return { fairValue: null, fairValueWithDividend: null, growthRate: g,
             isUndervalued: null, marginOfSafety: null };
  }

  const fairValue = eps * gPct;
  const fairValueWithDividend = eps * (gPct + dy * 100);
  if (!isPlausibleFairValue(fairValue, price)) {
    return { fairValue: null, fairValueWithDividend: null, growthRate: g,
             isUndervalued: null, marginOfSafety: null };
  }
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

  // Forward revenue: prefer +1y (next FY), fall back to +0y (current FY)
  const fwdRev1y = financials.earningsEstimates.find((e) => e.period === '+1y')?.revenueEstimate ?? null;
  const fwdRev0y = financials.earningsEstimates.find((e) => e.period === '+0y')?.revenueEstimate ?? null;
  const fwdRev   = fwdRev1y && fwdRev1y > 0 ? fwdRev1y : (fwdRev0y && fwdRev0y > 0 ? fwdRev0y : null);

  // Simple Valuation Ratio (run-rate P/S): drops the older 3 quarters from the
  // TTM denominator and annualizes the latest one. Reacts immediately to growth
  // inflections — TTM lags by 6+ months for fast movers. Caveat: distorted for
  // highly seasonal businesses (retail Q4, etc.).
  // Defensive: stale caches from before FINANCIALS_VERSION 14 won't have this
  // field at all, and the StaleBanner pipeline still serves them.
  const qRevs = Array.isArray(financials.quarterlyRevenues) ? financials.quarterlyRevenues : [];
  const latestQ = qRevs.length > 0 ? qRevs[qRevs.length - 1] : null;
  const latestQuarterRevenue = latestQ?.revenue ?? null;
  const latestQuarterEndDate = latestQ?.endDate ?? null;
  const simpleValuationRatio = mc && latestQuarterRevenue && latestQuarterRevenue > 0
    ? mc / (latestQuarterRevenue * 4)
    : null;

  return {
    enterpriseValue: ev,
    evToEbitda: ev && ebitda && ebitda > 0 ? ev / ebitda : null,
    evToRevenue: ev && rev && rev > 0       ? ev / rev   : null,
    evToFCF:    ev && fcf && fcf > 0        ? ev / fcf   : null,
    priceToFCF: mc && fcf && fcf > 0        ? mc / fcf   : null,
    priceToSales: mc && rev && rev > 0      ? mc / rev   : null,
    forwardPriceToSales: mc && fwdRev      ? mc / fwdRev : null,
    simpleValuationRatio,
    latestQuarterRevenue,
    latestQuarterEndDate,
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

// V* = EPS × (8.5 + 2g) × 4.4 / Y
// g = annual EPS growth rate (%), Y = AAA bond yield (%)
export function calculateGrahamRevised(
  financials: StockFinancials,
  bondYield = FALLBACK_AAA, // decimal
): GrahamRevisedResult {
  const eps = financials.eps;
  const price = financials.price;

  // Use 3Y EPS CAGR when available; cap at 15% per Graham's own rule
  const rawG = financials.epsGrowth3Y
    ?? (financials.earningsGrowth !== null && financials.revenueGrowth !== null
        ? Math.min(financials.earningsGrowth, financials.revenueGrowth)
        : financials.earningsGrowth ?? financials.revenueGrowth);
  const g = rawG !== null ? Math.max(0, Math.min(rawG, 0.15)) : null;

  if (!eps || eps <= 0 || g === null) {
    return { fairValue: null, bondYield, growthRate: null,
             marginOfSafety: null, isUndervalued: null };
  }

  // V* = EPS × (8.5 + 2G) × 4.4 / Y  — G and Y both expressed in percent
  const gPct     = g * 100;
  const yieldPct = bondYield * 100;
  const fairValue = (eps * (8.5 + 2 * gPct) * 4.4) / yieldPct;
  if (!isPlausibleFairValue(fairValue, price)) {
    return { fairValue: null, bondYield, growthRate: g, marginOfSafety: null, isUndervalued: null };
  }
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

  // F3: ROA improving
  const prevROA = py?.netIncome && py?.totalAssets && py.totalAssets > 0
    ? py.netIncome / py.totalAssets : null;
  const f3 = f.roa !== null && prevROA !== null ? f.roa > prevROA : null;

  // F4: Accruals — CFO/Assets > ROA
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
    thresholds = { safe: 2.99, distress: 1.81 };
    if (x1 !== null && x2 !== null && x3 !== null && x4 !== null && x5 !== null) {
      score = 1.2 * x1 + 1.4 * x2 + 3.3 * x3 + 0.6 * x4 + 1.0 * x5;
    }
  } else {
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

export function calculateDDM(financials: StockFinancials, riskFreeRate = FALLBACK_RFR): DDMResult {
  const dy   = financials.dividendYield;
  const price = financials.price;

  if (!dy || dy <= 0 || dy > 0.15) {
    return { fairValue: null, dividendPerShare: null, dividendGrowthRate: null,
             requiredReturn: null, isApplicable: false };
  }

  const dividendPerShare = price * dy;
  const requiredReturn = costOfEquity(financials.beta, riskFreeRate);

  const rawGrowth = financials.dividendGrowthRate5Y ?? financials.earningsGrowth ?? financials.revenueGrowth;
  const dividendGrowthRate = rawGrowth !== null
    ? Math.max(0, Math.min(rawGrowth, 0.10))
    : Math.min(0.05, requiredReturn - 0.03);

  if (dividendGrowthRate >= requiredReturn - 0.02) {
    return { fairValue: null, dividendPerShare, dividendGrowthRate, requiredReturn, isApplicable: true };
  }

  const d1 = dividendPerShare * (1 + dividendGrowthRate);
  const fairValue = d1 / (requiredReturn - dividendGrowthRate);

  if (fairValue > price * 15 || fairValue < 0) {
    return { fairValue: null, dividendPerShare, dividendGrowthRate, requiredReturn, isApplicable: true };
  }

  return { fairValue, dividendPerShare, dividendGrowthRate, requiredReturn, isApplicable: true };
}

// ─── 12. Earnings Power Value (Greenwald) — simplified ───────────────────────

export function calculateEPV(financials: StockFinancials, marketRates?: MarketRates): EPVResult {
  const rfr = marketRates?.riskFreeRate ?? FALLBACK_RFR;
  const r   = costOfEquity(financials.beta, rfr);
  const ebit = financials.ebit;
  const taxRate = financials.taxRate ?? 0.21;
  const price = financials.price;
  const shares = getShares(financials);

  if (!ebit || ebit <= 0 || !shares || shares <= 0) {
    return { fairValue: null, normalizedEbit: null, taxRate, wacc: r, marginOfSafety: null };
  }

  // Greenwald EPV: capitalise sustainable NOPAT at cost of capital, no growth.
  // We use latest-annual EBIT as proxy for sustainable EBIT (cycle-averaging would need
  // multi-year history we don't have).
  const normalizedEbit = ebit;
  const nopat = normalizedEbit * (1 - taxRate);
  const epv = nopat / r;

  const cash = financials.totalCash ?? 0;
  const debt = financials.totalDebt ?? 0;
  const equityValue = epv + cash - debt;
  const fairValue = equityValue / shares;

  if (!isPlausibleFairValue(fairValue, price)) {
    return { fairValue: null, normalizedEbit, taxRate, wacc: r, marginOfSafety: null };
  }
  const marginOfSafety = (fairValue - price) / price;

  return { fairValue, normalizedEbit, taxRate, wacc: r, marginOfSafety };
}

// ─── 13. Residual Income Model (Edwards–Bell–Ohlson) ─────────────────────────

export function calculateRIM(financials: StockFinancials, marketRates?: MarketRates): RIMResult {
  const rfr = marketRates?.riskFreeRate ?? FALLBACK_RFR;
  const r   = costOfEquity(financials.beta, rfr);
  const bv0 = financials.bookValue;
  const roeRaw = financials.roe;
  const price = financials.price;

  if (!bv0 || bv0 <= 0 || !roeRaw || roeRaw <= 0) {
    return {
      fairValue: null, costOfEquity: r, excessReturn: null,
      bookValuePerShare: bv0 ?? null, marginOfSafety: null, isApplicable: false,
    };
  }

  // Cap ROE to avoid extreme implied compounding (e.g., book-value-near-zero firms with ROE > 100%)
  const roe = Math.min(roeRaw, 0.30);
  const payout = financials.payoutRatio !== null
    ? Math.max(0, Math.min(financials.payoutRatio, 0.95))
    : 0.30; // default reinvestment assumption when no dividend
  const retention = 1 - payout;

  const horizon = 5;
  let bvPrev = bv0;
  let pvExcess = 0;
  for (let t = 1; t <= horizon; t++) {
    const excessReturn = (roe - r) * bvPrev;
    pvExcess += excessReturn / Math.pow(1 + r, t);
    bvPrev = bvPrev * (1 + roe * retention);
  }

  // Terminal residual income assumed = 0 (excess returns fade to zero in the long run).
  const fairValue = bv0 + pvExcess;
  if (!isPlausibleFairValue(fairValue, price)) {
    // Outlier — typically per-share book-value unit mismatch (dual-class shares).
    return {
      fairValue: null, costOfEquity: r, excessReturn: roe - r,
      bookValuePerShare: bv0, marginOfSafety: null, isApplicable: false,
    };
  }
  const marginOfSafety = (fairValue - price) / price;

  return {
    fairValue,
    costOfEquity: r,
    excessReturn: roe - r,
    bookValuePerShare: bv0,
    marginOfSafety,
    isApplicable: true,
  };
}

// ─── 14. Net Current Asset Value (Graham Net-Net) ────────────────────────────

export function calculateNCAV(financials: StockFinancials): NCAVResult {
  const ca = financials.totalCurrentAssets;
  const tl = financials.totalLiabilities;
  const shares = getShares(financials);
  const price = financials.price;

  if (ca === null || tl === null || !shares || shares <= 0 || ca <= tl) {
    return { ncavPerShare: null, buyThreshold: null, marginOfSafety: null, isApplicable: false };
  }

  const ncavPerShare = (ca - tl) / shares;
  const buyThreshold = (2 / 3) * ncavPerShare;
  if (!isPlausibleFairValue(ncavPerShare, price)) {
    return { ncavPerShare: null, buyThreshold: null, marginOfSafety: null, isApplicable: false };
  }
  const marginOfSafety = (ncavPerShare - price) / price;

  return { ncavPerShare, buyThreshold, marginOfSafety, isApplicable: true };
}

// ─── 15. Peer-Multiples Fair Value ───────────────────────────────────────────

export function calculatePeerMultiples(
  financials: StockFinancials,
  sectorMedians: SectorMedians | null,
): PeerMultiplesResult {
  const empty = (): PeerMultiplesResult => ({
    byMultiple: [], medianFairPrice: null, meanFairPrice: null,
    count: 0, marginOfSafety: null,
  });

  if (!sectorMedians) return empty();

  const shares = getShares(financials);
  const cash   = financials.totalCash ?? 0;
  const debt   = financials.totalDebt ?? 0;
  const netDebt = debt - cash;
  const price = financials.price;

  const entries: PeerMultiplesEntry[] = [];

  // P/E
  const eps = financials.eps;
  const pePeer = sectorMedians.pe;
  if (eps !== null && eps > 0 && pePeer !== null && pePeer > 0) {
    entries.push({ metric: 'pe', ownMetric: eps, sectorMedian: pePeer, fairPrice: pePeer * eps });
  }

  // EV/EBITDA → equity bridge
  const ebitda = financials.ebitda;
  const evEbitdaPeer = sectorMedians.evToEbitda;
  if (ebitda !== null && ebitda > 0 && evEbitdaPeer !== null && evEbitdaPeer > 0) {
    const fairEV = evEbitdaPeer * ebitda;
    entries.push({
      metric: 'evEbitda', ownMetric: ebitda, sectorMedian: evEbitdaPeer,
      fairPrice: (fairEV - netDebt) / shares,
    });
  }

  // EV/Revenue → equity bridge
  const rev = financials.revenue;
  const evRevPeer = sectorMedians.evToRevenue;
  if (rev !== null && rev > 0 && evRevPeer !== null && evRevPeer > 0) {
    const fairEV = evRevPeer * rev;
    entries.push({
      metric: 'evRevenue', ownMetric: rev, sectorMedian: evRevPeer,
      fairPrice: (fairEV - netDebt) / shares,
    });
  }

  // P/FCF
  const fcf = financials.freeCashFlow;
  const pFcfPeer = sectorMedians.priceToFCF;
  if (fcf !== null && fcf > 0 && pFcfPeer !== null && pFcfPeer > 0) {
    entries.push({
      metric: 'priceFCF', ownMetric: fcf, sectorMedian: pFcfPeer,
      fairPrice: (pFcfPeer * fcf) / shares,
    });
  }

  // P/S — equity-side analogue of EV/Revenue (no equity bridge applied since P/S is already a market-cap-based multiple)
  const psPeer = sectorMedians.priceToSales;
  if (rev !== null && rev > 0 && psPeer !== null && psPeer > 0) {
    entries.push({
      metric: 'priceSales', ownMetric: rev, sectorMedian: psPeer,
      fairPrice: (psPeer * rev) / shares,
    });
  }

  // P/B
  const bv = financials.bookValue;
  const pbPeer = sectorMedians.pb;
  if (bv !== null && bv > 0 && pbPeer !== null && pbPeer > 0) {
    entries.push({ metric: 'pb', ownMetric: bv, sectorMedian: pbPeer, fairPrice: pbPeer * bv });
  }

  // Drop per-multiple outliers (e.g., P/B based fair value when book value is in
  // wrong share-class units).
  for (const e of entries) {
    if (!isPlausibleFairValue(e.fairPrice, price)) e.fairPrice = null;
  }

  if (entries.length === 0) return empty();

  const fairs = entries.map((e) => e.fairPrice).filter((x): x is number => x !== null && Number.isFinite(x));
  const medianFP = median(fairs);
  const meanFP = fairs.length > 0 ? fairs.reduce((s, v) => s + v, 0) / fairs.length : null;
  const marginOfSafety = medianFP !== null ? (medianFP - price) / price : null;

  return {
    byMultiple: entries,
    medianFairPrice: medianFP,
    meanFairPrice: meanFP,
    count: fairs.length,
    marginOfSafety,
  };
}

// ─── 16. Sortino Ratio ───────────────────────────────────────────────────────

export function calculateSortino(financials: StockFinancials, riskFreeRate = FALLBACK_RFR): SortinoResult {
  const returns = financials.monthlyReturns ?? [];
  const unknown: SortinoResult = {
    ratio: null, annualReturn: null, downsideDeviation: null,
    riskFreeRate, interpretation: 'unknown',
  };

  if (returns.length < 6) return unknown;

  // Annualise compound return: (∏(1+r))^(12/n) − 1 — handles n < 12 correctly.
  const cumulative = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const annualReturn = Math.pow(1 + cumulative, 12 / returns.length) - 1;

  const monthlyRfr = riskFreeRate / 12;
  const negativeExcess = returns.map((r) => Math.min(r - monthlyRfr, 0));
  const meanSquared = negativeExcess.reduce((s, r) => s + r * r, 0) / negativeExcess.length;
  const downsideDeviation = Math.sqrt(meanSquared) * Math.sqrt(12);

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

// ─── 17. Beneish M-Score ─────────────────────────────────────────────────────

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

  const gm0 = py.revenue && py.revenue > 0 && py.grossProfit !== null ? py.grossProfit / py.revenue : null;
  const gm1 = f.revenue && f.revenue > 0 && f.grossProfit !== null ? f.grossProfit / f.revenue : null;
  const gmi = gm0 !== null && gm1 !== null && gm1 > 0 ? gm0 / gm1 : null;

  const sgi = py.revenue && py.revenue > 0 && f.revenue ? f.revenue / py.revenue : null;

  const tata = f.netIncome !== null && f.operatingCashFlow !== null
    ? (f.netIncome - f.operatingCashFlow) / f.totalAssets
    : null;

  const lev1 = f.longTermDebt !== null && f.totalCurrentLiabilities !== null
    ? (f.longTermDebt + f.totalCurrentLiabilities) / f.totalAssets : null;
  const lev0 = py.longTermDebt !== null && py.currentLiabilities !== null && py.totalAssets && py.totalAssets > 0
    ? (py.longTermDebt + py.currentLiabilities) / py.totalAssets : null;
  const lvgi = lev1 !== null && lev0 !== null && lev0 > 0 ? lev1 / lev0 : null;

  const dsr1 = f.receivables !== null && f.revenue && f.revenue > 0 ? f.receivables / f.revenue : null;
  const dsr0 = py.receivables !== null && py.revenue && py.revenue > 0 ? py.receivables / py.revenue : null;
  const dsri = dsr1 !== null && dsr0 !== null && dsr0 > 0 ? dsr1 / dsr0 : null;

  const aq1 = f.ppe !== null && f.totalCurrentAssets !== null
    ? 1 - (f.totalCurrentAssets + f.ppe) / f.totalAssets : null;
  const aq0 = py.ppe !== null && py.currentAssets !== null && py.totalAssets && py.totalAssets > 0
    ? 1 - (py.currentAssets + py.ppe) / py.totalAssets : null;
  const aqi = aq1 !== null && aq0 !== null && aq0 > 0 ? aq1 / aq0 : null;

  const dep1 = f.depreciation;
  const dep0 = py.depreciation;
  const depi = dep1 !== null && dep0 !== null && f.ppe !== null && py.ppe !== null
    && (f.ppe + dep1) > 0 && (py.ppe + dep0) > 0
    ? (dep0 / (py.ppe + dep0)) / (dep1 / (f.ppe + dep1))
    : null;

  const sgai1 = f.sga !== null && f.revenue && f.revenue > 0 ? f.sga / f.revenue : null;
  const sgai0 = py.sga !== null && py.revenue && py.revenue > 0 ? py.sga / py.revenue : null;
  const sgai = sgai1 !== null && sgai0 !== null && sgai0 > 0 ? sgai1 / sgai0 : null;

  const indices = [dsri, gmi, aqi, sgi, depi, sgai, tata, lvgi];
  const computed = indices.filter((x) => x !== null).length;

  // Require at least 5 of 8 indices — Beneish's coefficients are calibrated assuming
  // all 8 are present. Substituting 1.0 for too many missing values systematically
  // pushes the score toward "manipulator" (the all-1.0 score is +1.20).
  if (computed < 5) {
    return {
      score: null, probability: 'unknown',
      dsri, gmi, aqi, sgi, depi, sgai, tata, lvgi,
      variablesComputed: computed,
    };
  }

  const v = (x: number | null) => x ?? 1.0;
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

// ─── 18. Interest Coverage ───────────────────────────────────────────────────

export function calculateInterestCoverage(financials: StockFinancials): InterestCoverageResult {
  const ebit = financials.ebit;
  const interest = financials.interestExpense;

  if (!ebit || !interest || interest === 0) {
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

// ─── 19. Composite Fair Value ────────────────────────────────────────────────

export interface CompositeInputs {
  dcf: DCFResult;
  graham: GrahamResult;
  grahamRevised: GrahamRevisedResult;
  peterLynch: PeterLynchResult;
  ddm: DDMResult;
  epv: EPVResult;
  rim: RIMResult;
  peerMultiples: PeerMultiplesResult;
  beneish: BeneishResult;
}

/**
 * Tiered composite fair value:
 *
 *   PRIMARY (headline):
 *     Market-aligned, growth-aware models. The median of this tier is THE fair
 *     value shown in the UI hero.
 *       • DCF (2-Stage FCFF)         — analyst-forward growth, terminal fade
 *       • Peer Multiples (median)    — implied price across 5–6 sector medians
 *       • Peter Lynch                — EPS × growth%
 *       • Analyst Consensus          — mean of analyst price targets
 *
 *   CONSERVATIVE (value lens):
 *     Backward-looking / no-growth perspective. Useful as a sanity floor and
 *     for mature firms, but systematically pessimistic for growers.
 *       • Graham Number              — sqrt(22.5 · EPS · BV)
 *       • Graham Revised V*          — capped at 15% growth (Graham's own rule)
 *       • EPV (Greenwald)            — NOPAT capitalised at WACC, no growth
 *       • RIM (Residual Income)      — book value + excess returns
 *       • DDM (Gordon Growth)        — dividend-based
 *
 * NCAV is excluded entirely — it's a liquidation floor in a different unit.
 *
 * The tier split is the right answer to "Graham/EPV always drag the median
 * down for growth firms" — they're now a separate lens, not part of the
 * headline. The user sees both in the UI.
 */
function tierStats(price: number, models: CompositeContributor[]): CompositeTier {
  const fvs = models.map((m) => m.fairValue);
  if (fvs.length === 0) {
    return { median: null, mean: null, p25: null, p75: null, min: null, max: null, marginOfSafety: null, models };
  }
  const med = median(fvs);
  const p25 = percentile(fvs, 0.25);
  const p75 = percentile(fvs, 0.75);
  const minV = Math.min(...fvs);
  const maxV = Math.max(...fvs);
  const meanV = fvs.reduce((s, v) => s + v, 0) / fvs.length;
  const mos = med !== null ? (med - price) / price : null;
  return { median: med, mean: meanV, p25, p75, min: minV, max: maxV, marginOfSafety: mos, models };
}

export function calculateCompositeFairValue(financials: StockFinancials, inputs: CompositeInputs): CompositeFairValueResult {
  const price = financials.price;
  const rimExcessTooNegative = inputs.rim.excessReturn !== null && inputs.rim.excessReturn < -0.03;

  const primary: CompositeContributor[]      = [];
  const conservative: CompositeContributor[] = [];
  const excluded: CompositeExclusion[]       = [];

  function add(tier: 'primary' | 'conservative', name: string, value: number | null, missingReason: string, skipReason?: string) {
    if (skipReason) {
      excluded.push({ name, reason: skipReason });
      return;
    }
    if (value !== null && Number.isFinite(value) && value > 0) {
      (tier === 'primary' ? primary : conservative).push({ name, fairValue: value });
    } else {
      excluded.push({ name, reason: missingReason });
    }
  }

  // ── PRIMARY tier ──
  add('primary', 'DCF (2-Stage FCFF)', inputs.dcf.fairValue, 'Negative FCF or unstable r vs g');
  add('primary', 'Peer Multiples',     inputs.peerMultiples.medianFairPrice, 'No peer-group data');
  add('primary', 'Peter Lynch',        inputs.peterLynch.fairValue,         'Requires positive EPS and growth');
  // Analyst target = market consensus, treated as one more "model" for triangulation.
  if (financials.targetMeanPrice !== null && Number.isFinite(financials.targetMeanPrice) && financials.targetMeanPrice > 0) {
    primary.push({ name: 'Analyst Consensus', fairValue: financials.targetMeanPrice });
  } else {
    excluded.push({ name: 'Analyst Consensus', reason: 'No analyst coverage' });
  }

  // ── CONSERVATIVE tier ──
  add('conservative', 'Graham Number',     inputs.graham.grahamNumber,     'Requires positive EPS and book value');
  add('conservative', 'Graham Revised V*', inputs.grahamRevised.fairValue, 'Requires positive EPS and growth');
  add('conservative', 'EPV (Greenwald)',   inputs.epv.fairValue,           'Requires positive EBIT');
  add('conservative', 'Residual Income (RIM)', inputs.rim.fairValue, 'Requires positive book value and ROE',
    rimExcessTooNegative
      ? `Trailing ROE far below cost of equity (excess ${(inputs.rim.excessReturn! * 100).toFixed(1)}pp) — RIM understates future earning power for firms in heavy investment phase`
      : undefined);
  add('conservative', 'DDM (Gordon)',
    inputs.ddm.isApplicable ? inputs.ddm.fairValue : null,
    inputs.ddm.isApplicable ? 'g approaches r — model unstable' : 'No dividend');

  const primaryTier      = tierStats(price, primary);
  const conservativeTier = tierStats(price, conservative);

  // Confidence (0-10) based on primary tier coverage + IQR tightness + Beneish.
  const coverageScore = Math.min(primary.length / 4, 1) * 5;
  const iqrRel = primaryTier.median && primaryTier.median > 0 && primaryTier.p25 !== null && primaryTier.p75 !== null
    ? (primaryTier.p75 - primaryTier.p25) / primaryTier.median
    : 1.0;
  const tightnessBonus =
    iqrRel < 0.15 ? 5 :
    iqrRel < 0.30 ? 4 :
    iqrRel < 0.50 ? 3 :
    iqrRel < 0.80 ? 2 : 1;
  let confidence = coverageScore + tightnessBonus;
  if (inputs.beneish.probability === 'likely manipulator') confidence /= 2;
  if (primary.length < 2) confidence = 0;
  confidence = Math.max(0, Math.min(10, Math.round(confidence * 10) / 10));

  const pctPrimaryUndervalued = primary.length > 0
    ? primary.filter((c) => c.fairValue > price).length / primary.length
    : null;

  return {
    primary:      primaryTier,
    conservative: conservativeTier,
    excludedModels: excluded,
    confidence,
    pctPrimaryUndervalued,

    // Aliases — same as primary.* for backwards compat
    median:               primaryTier.median,
    mean:                 primaryTier.mean,
    p25:                  primaryTier.p25,
    p75:                  primaryTier.p75,
    min:                  primaryTier.min,
    max:                  primaryTier.max,
    marginOfSafety:       primaryTier.marginOfSafety,
    pctModelsUndervalued: pctPrimaryUndervalued,
    contributingModels:   primary,
  };
}
