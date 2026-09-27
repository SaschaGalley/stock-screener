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
  RIMResult,
  RuleOf40Result,
  SectorMedians,
  SortinoResult,
  StockFinancials,
} from '../types.js';
import { FALLBACK_RATES, MarketRates } from '../data/fred.js';
import { seasonallyAdjustedRunRate } from './run-rate.js';
import { consecutiveQuarters, latestValue, YearPoint } from './trailing.js';
import { ValuationBasis, equityPerShare, valuationBasis } from './basis.js';
import { costOfEquity, terminalGrowth, wacc } from './cost-of-capital.js';
import { borrowsToLend, isPlausibleFairValue, LENDER_NOTE } from './dcf.js';
import { quantileSorted } from './sampling.js';
import { toFiniteNumber } from '../utils/num.js';

// ─── Formatting helpers ───────────────────────────────────────────────────────

// Formatting lives in src/format.ts, shared with the web UI — re-exported here
// so the report writers keep importing it from where they always have.
export { fmt, fmtPct, fmtBig } from '../format.js';

// The DCF, its reverse, and the question of whether a company lends for a
// living live in `dcf.ts`; re-exported so the models keep one import surface.
export { calculateDCF, calculateReverseDCF, borrowsToLend, isBalanceSheetFinancial } from './dcf.js';

// ─── Shared helpers ──────────────────────────────────────────────────────────

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
}

function mean(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Normalised "earnings power" for a trailing flow. Valuation models that anchor
 * on a single trailing figure are distorted when that figure is hit by
 * one-offs — Honeywell's trailing FCF was $2.9B against a steady ~$5B history,
 * dragging its old DCF to $68 (−70% MoS) versus a $246 analyst target.
 *
 * Correction is intentionally ONE-DIRECTIONAL: only lift a *depressed* trailing
 * figure (sharply below the recent annual average) up to that average. A
 * trailing figure ABOVE trend is left alone — for a compounder that is genuine
 * growth and the trailing value is the better base.
 *
 * Guards (return trailing unchanged when any fails): ≥2 recent annual points,
 * and trailing and every recent point share a sign — never average across a
 * loss→profit regime change.
 */
function normalizedFlow(trailing: number | null, history: YearPoint[]): number | null {
  const recent = history.slice(-3).map((p) => p.value);
  if (recent.length < 2) return trailing;
  const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
  if (trailing === null) {
    return recent.every((v) => v > 0) || recent.every((v) => v < 0) ? avg : null;
  }
  const sameSign = recent.every((v) => Math.sign(v) === Math.sign(trailing));
  if (!sameSign || avg === 0) return trailing;
  if (trailing >= avg) return trailing;
  const shortfall = (avg - trailing) / Math.abs(avg);
  return shortfall > 0.25 ? avg : trailing;
}

/**
 * Earnings per diluted share, normalised: net income excluding unusual items
 * over the trailing four quarters, lifted to the recent average when a one-off
 * has depressed it, divided by every share including dilution. Not Yahoo's
 * per-share figure, which is per ordinary share for an ADR and per class for a
 * multi-class company — Sanofi's ADR carries half an ordinary share's EPS.
 */
function normalizedEps(b: ValuationBasis): number | null {
  const earnings = normalizedFlow(b.earnings, b.earningsHistory);
  return earnings !== null && b.dilutedShares !== null && b.dilutedShares > 0 ? earnings / b.dilutedShares : null;
}

/**
 * Next-FY analyst EPS growth — or null when the rate is not a rate.
 *
 * Measured against the current fiscal year, so a loss in that base makes the
 * ratio a sign-change artefact: AMS.SW's −1.05 → +0.96 was reported as +191 %.
 * Both years must be positive. A *negative* rate on positive earnings is a real
 * forecast and is returned as one — it used to be discarded, and the models
 * reached for the past instead: Novo Nordisk, with the consensus expecting
 * earnings to fall, was grown at its 24 % three-year history.
 */
export function forwardEpsGrowth(f: StockFinancials): number | null {
  const ests = f.earningsEstimates ?? [];
  const ey0 = ests.find((e) => e.period === '0y');
  const ey1 = ests.find((e) => e.period === '+1y');
  if (ey0?.epsEstimate == null || ey0.epsEstimate <= 0) return null;
  if (ey1?.epsEstimate == null || ey1.epsEstimate <= 0) return null;
  return toFiniteNumber(ey1.epsGrowth);
}

/** What the quarterly revenue series says about the current revenue level. */
interface RevenueRunRate {
  latestQuarterRevenue: number | null;
  latestQuarterEndDate: string | null;
  /** Latest quarter against the same quarter a year earlier (decimal). */
  latestQuarterYoYGrowth: number | null;
  /**
   * The last four quarters grown to where the latest one stands. Equals the
   * latest quarter × 4 when revenue grows steadily; for a seasonal business it
   * is that figure with the pattern divided out.
   */
  seasonallyAdjustedRunRate: number | null;
}

function revenueRunRate(f: StockFinancials): RevenueRunRate {
  const quarters = Array.isArray(f.quarterlyRevenues) ? f.quarterlyRevenues : [];
  const latest = quarters.length > 0 ? quarters[quarters.length - 1] : null;
  const level: RevenueRunRate = {
    latestQuarterRevenue: latest?.revenue ?? null,
    latestQuarterEndDate: latest?.endDate ?? null,
    latestQuarterYoYGrowth: null,
    seasonallyAdjustedRunRate: null,
  };
  // A year-ago comparison across a dropped quarter compares five quarters' time.
  const five = consecutiveQuarters(quarters.map((q) => ({ endDate: q.endDate, value: q.revenue })), 5);
  if (!latest || !five || five.some((q) => q.value <= 0)) return level;
  const yoy = five[4].value / five[0].value - 1;
  return {
    ...level,
    latestQuarterYoYGrowth: yoy,
    seasonallyAdjustedRunRate: seasonallyAdjustedRunRate(five.slice(1).map((q) => q.value), yoy),
  };
}

// ─── Graham Number ───────────────────────────────────────────────────────────

export function calculateGraham(financials: StockFinancials): GrahamResult {
  const b = valuationBasis(financials);
  const eps = normalizedEps(b);
  const bv = b.bookValuePerShare;
  if (eps === null || eps <= 0 || bv === null || bv <= 0) {
    return { grahamNumber: null, marginOfSafety: null, isUndervalued: false };
  }
  const grahamNumber = Math.sqrt(22.5 * eps * bv);
  if (!isPlausibleFairValue(grahamNumber, b.price)) {
    return { grahamNumber: null, marginOfSafety: null, isUndervalued: false };
  }
  const marginOfSafety = (grahamNumber - b.price) / b.price;
  return { grahamNumber, marginOfSafety, isUndervalued: grahamNumber > b.price };
}

// ─── Key ratios (incl. owner earnings yield) ─────────────────────────────────

export function calculateRatios(financials: StockFinancials): RatioResult {
  const b = valuationBasis(financials);
  const pb = b.bookValuePerShare !== null && b.bookValuePerShare > 0 ? b.price / b.bookValuePerShare : null;

  // Owner Earnings (Buffett): NI + D&A − maintenance CapEx (≈ CapEx as proxy)
  const ni    = financials.netIncome;
  const dep   = financials.depreciation;
  const capex = financials.capex;
  const mc    = financials.marketCap;
  const oe = (ni !== null && dep !== null && capex !== null) ? ni + dep - Math.abs(capex) : null;
  const ownerEarningsYield = oe !== null && mc > 0 ? oe / mc : null;

  return {
    pe: financials.peRatio, forwardPE: financials.forwardPE, peg: financials.pegRatio, pb,
    roe: financials.roe, roa: financials.roa, debtToEquity: financials.debtToEquity,
    currentRatio: financials.currentRatio, operatingMargin: financials.operatingMargin,
    netMargin: financials.netMargin, revenueGrowth: b.revenueGrowth,
    dividendYield: financials.dividendYield,
    ownerEarningsYield,
  };
}

// ─── Peter Lynch ─────────────────────────────────────────────────────────────

/**
 * Growth beyond which Lynch's rule stops meaning anything. His fair P/E equal to
 * the growth rate was for stalwarts and fast growers, and he distrusted rates
 * above about 25 %: nobody compounds 40 % for long, and a rule that pays a P/E
 * of 105 for Advanced Micro Devices' 105 % consensus is a rule taken beyond its
 * range. Uncapped it valued Amazon at 11.7× its price on a quarterly earnings
 * jump.
 */
export const LYNCH_MAX_GROWTH = 0.25;

/** Below this the rule prices a slow grower at a P/E of five — not what it is for. */
export const LYNCH_MIN_GROWTH = 0.05;

/**
 * Lynch's fair value: a P/E equal to growth plus dividend yield, in percent, on
 * normalised earnings. Growth is the next-year consensus where analysts publish
 * one — a negative one means no growth to price, and the rule abstains — else
 * the three-year EPS CAGR. Never a single quarter's jump.
 */
export function calculatePeterLynch(financials: StockFinancials): PeterLynchResult {
  const b = valuationBasis(financials);
  const eps = normalizedEps(b);
  const fwd = forwardEpsGrowth(financials);
  const g = fwd ?? toFiniteNumber(financials.epsGrowth3Y);
  const dy = toFiniteNumber(financials.dividendYield) ?? 0;
  const none = (growthRate: number | null): PeterLynchResult => ({
    fairValue: null, growthRate, growthSource: fwd !== null ? 'consensus' : g !== null ? '3y CAGR' : null,
    isUndervalued: null, marginOfSafety: null,
  });

  if (eps === null || eps <= 0 || g === null || g < LYNCH_MIN_GROWTH) return none(g);
  const growth = Math.min(g, LYNCH_MAX_GROWTH);
  const fairValue = eps * (growth + dy) * 100;
  if (!isPlausibleFairValue(fairValue, b.price)) return none(growth);
  return {
    fairValue,
    growthRate: growth,
    growthSource: fwd !== null ? 'consensus' : '3y CAGR',
    isUndervalued: fairValue > b.price,
    marginOfSafety: (fairValue - b.price) / b.price,
  };
}

// ─── EV multiples ────────────────────────────────────────────────────────────

export function calculateEVMultiples(financials: StockFinancials): EVMultiplesResult {
  const b = valuationBasis(financials);
  const ev  = financials.enterpriseValue;
  const ebitda = financials.ebitda;
  const rev = financials.revenue;
  const fcf = b.freeCashFlow;
  const mc  = financials.marketCap;

  // Forward revenue: prefer +1y (next FY), fall back to 0y (current FY).
  const fwdRev1y = financials.earningsEstimates.find((e) => e.period === '+1y')?.revenueEstimate ?? null;
  const fwdRev0y = financials.earningsEstimates.find((e) => e.period === '0y')?.revenueEstimate ?? null;
  const fwdRev   = fwdRev1y && fwdRev1y > 0 ? fwdRev1y : (fwdRev0y && fwdRev0y > 0 ? fwdRev0y : null);

  // Simple Valuation Ratio (run-rate P/S): drops the older 3 quarters from the
  // TTM denominator and annualizes the latest one. Reacts immediately to growth
  // inflections; the seasonally adjusted variant next to it corrects for a
  // latest quarter that is a seasonal high or low.
  const runRate = revenueRunRate(financials);
  const { latestQuarterRevenue, latestQuarterEndDate, latestQuarterYoYGrowth } = runRate;
  const simpleValuationRatio = mc && latestQuarterRevenue && latestQuarterRevenue > 0
    ? mc / (latestQuarterRevenue * 4)
    : null;
  const seasonallyAdjustedValuationRatio = mc && runRate.seasonallyAdjustedRunRate
    ? mc / runRate.seasonallyAdjustedRunRate
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
    seasonallyAdjustedValuationRatio,
    seasonalGap: simpleValuationRatio !== null && seasonallyAdjustedValuationRatio !== null
      ? simpleValuationRatio / seasonallyAdjustedValuationRatio - 1
      : null,
    latestQuarterRevenue,
    latestQuarterEndDate,
    latestQuarterYoYGrowth,
  };
}

// ─── Rule of 40 ──────────────────────────────────────────────────────────────

/**
 * A margin, taken from the source the data-quality audit trusts.
 *
 * The audit flags a trailing margin that contradicts the fiscal year, and its
 * finding says to prefer the statements — but every consumer went on reading the
 * flagged figure anyway. ServiceNow reported a trailing operating margin of
 * 4.1 % beside a trailing *net* margin of 11.3 %, interest covered 99 times and
 * a free-cash-flow margin of 35 %; the fiscal year says 13.7 %.
 *
 * When the audit named the field, the newest full fiscal year answers instead.
 */
export function reliableMargin(
  f: StockFinancials, field: 'operatingMargin' | 'netMargin',
): { value: number | null; source: 'reported' | 'statement' } {
  const reported = toFiniteNumber(f[field]);
  const flagged = (f.dataQualityWarnings ?? [])
    .some((w) => w.code === 'margin-mismatch' && w.fields.includes(field));
  if (!flagged) return { value: reported, source: 'reported' };

  const series = field === 'operatingMargin'
    ? f.fundamentalsHistory?.operatingIncome
    : f.fundamentalsHistory?.netIncome;
  const numerator = latestValue(series);
  const revenue = latestValue(f.fundamentalsHistory?.revenue);
  return numerator !== null && revenue !== null && revenue > 0
    ? { value: numerator / revenue, source: 'statement' }
    : { value: reported, source: 'reported' };
}

export function calculateRuleOf40(financials: StockFinancials): RuleOf40Result {
  const rg = valuationBasis(financials).revenueGrowth;
  const pm = reliableMargin(financials, 'operatingMargin').value
    ?? reliableMargin(financials, 'netMargin').value;

  if (rg === null || pm === null) {
    return { score: null, revenueGrowthPct: null, profitMarginPct: null, passes: null };
  }
  const rgPct = rg * 100;
  const pmPct = pm * 100;
  const score = rgPct + pmPct;
  return { score, revenueGrowthPct: rgPct, profitMarginPct: pmPct, passes: score >= 40 };
}

// ─── Revised Graham formula ──────────────────────────────────────────────────

/**
 * V* = EPS × (8.5 + 2g) × 4.4 / Y — g the annual EPS growth in percent, capped at
 * Graham's own 15, Y the AAA yield in percent. Growth is the three-year EPS CAGR,
 * else the statements' earnings growth; never a quarter's.
 *
 * Y is a *dollar* AAA yield, and discounting a Swiss or Japanese company with it
 * charged a 4 % Treasury market's rate to cash flows priced off a 1 % one — V*
 * came out 2.5× too low in yen. The caller passes the AAA spread over Treasuries
 * on top of the stock's own currency's government rate.
 */
export function calculateGrahamRevised(
  financials: StockFinancials,
  bondYield = FALLBACK_RATES.aaaBondYield,
): GrahamRevisedResult {
  const b = valuationBasis(financials);
  const eps = normalizedEps(b);
  const rawG = toFiniteNumber(financials.epsGrowth3Y) ?? b.earningsGrowth;
  const g = rawG !== null ? Math.max(0, Math.min(rawG, 0.15)) : null;

  if (eps === null || eps <= 0 || g === null || !(bondYield > 0)) {
    return { fairValue: null, bondYield, growthRate: g, marginOfSafety: null, isUndervalued: null };
  }
  const fairValue = (eps * (8.5 + 2 * g * 100) * 4.4) / (bondYield * 100);
  if (!isPlausibleFairValue(fairValue, b.price)) {
    return { fairValue: null, bondYield, growthRate: g, marginOfSafety: null, isUndervalued: null };
  }
  const marginOfSafety = (fairValue - b.price) / b.price;
  return { fairValue, bondYield, growthRate: g, marginOfSafety, isUndervalued: fairValue > b.price };
}

// ─── Piotroski F-Score ───────────────────────────────────────────────────────

export function calculatePiotroski(financials: StockFinancials): PiotroskiResult {
  const f = financials;
  const py = f.prevYear;

  // Use annual statement figures (not Yahoo's TTM/average-asset ROA) so both
  // sides of the YoY comparisons are on a consistent end-of-period annual basis.
  const latest = (s: YearPoint[]): number | null => s.length ? s[s.length - 1].value : null;
  const niAnnual  = latest(f.fundamentalsHistory.netIncome) ?? f.netIncome;
  const revAnnual = latest(f.fundamentalsHistory.revenue) ?? f.revenue;
  const gpAnnual  = latest(f.fundamentalsHistory.grossProfit) ?? f.grossProfit;
  const ocfAnnual = f.operatingCashFlowAnnual ?? f.operatingCashFlow;
  const roaCur = niAnnual !== null && f.totalAssets !== null && f.totalAssets > 0
    ? niAnnual / f.totalAssets : null;

  // Profitability
  const f1 = roaCur !== null ? roaCur > 0 : null;
  const f2 = ocfAnnual !== null ? ocfAnnual > 0 : null;

  // F3: ROA improving (annual NI / end-of-period assets, both years)
  const prevROA = py?.netIncome != null && py?.totalAssets != null && py.totalAssets > 0
    ? py.netIncome / py.totalAssets : null;
  const f3 = roaCur !== null && prevROA !== null ? roaCur > prevROA : null;

  // F4: Accruals — CFO/Assets > ROA, both on the same annual asset base
  const cfRoa = ocfAnnual !== null && f.totalAssets !== null && f.totalAssets > 0
    ? ocfAnnual / f.totalAssets : null;
  const f4 = cfRoa !== null && roaCur !== null ? cfRoa > roaCur : null;

  // F5: leverage did not rise. Piotroski scores a *fall*, and read literally
  // that fails every firm without debt in both years — the one balance sheet
  // that cannot have become more leveraged. No debt then and now passes.
  const currLeverage = f.longTermDebt !== null && f.totalAssets && f.totalAssets > 0
    ? f.longTermDebt / f.totalAssets : null;
  const prevLeverage = py?.longTermDebt !== null && py?.totalAssets && py.totalAssets > 0
    ? py.longTermDebt! / py.totalAssets : null;
  const f5 = currLeverage !== null && prevLeverage !== null
    ? currLeverage < prevLeverage || (currLeverage === 0 && prevLeverage === 0)
    : null;

  // Current ratio from annual balance-sheet figures (matches the annual prior
  // year); fall back to Yahoo's current-ratio field only if annual is missing.
  const currCR = f.totalCurrentAssets != null && f.totalCurrentLiabilities != null && f.totalCurrentLiabilities > 0
    ? f.totalCurrentAssets / f.totalCurrentLiabilities : f.currentRatio;
  const prevCR = py?.currentAssets != null && py?.currentLiabilities != null && py.currentLiabilities > 0
    ? py.currentAssets / py.currentLiabilities : null;
  const f6 = currCR !== null && prevCR !== null ? currCR > prevCR : null;

  // F7: no new shares — the latest fiscal year's weighted-average count against
  // the prior year's, one measure for both.
  const sharesNow  = f.sharesOutstandingAnnual ?? null;
  const sharesPrev = py?.sharesOutstanding ?? null;
  const f7 = sharesNow !== null && sharesPrev !== null ? sharesNow <= sharesPrev : null;

  // Efficiency — current side on the annual basis to match the annual prior year
  const currGM = gpAnnual != null && revAnnual != null && revAnnual > 0 ? gpAnnual / revAnnual : null;
  const prevGM = py?.grossProfit != null && py?.revenue != null && py.revenue > 0 ? py.grossProfit / py.revenue : null;
  const f8 = currGM !== null && prevGM !== null ? currGM > prevGM : null;

  const currAT = revAnnual != null && f.totalAssets != null && f.totalAssets > 0 ? revAnnual / f.totalAssets : null;
  const prevAT = py?.revenue != null && py?.totalAssets != null && py.totalAssets > 0 ? py.revenue / py.totalAssets : null;
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

// ─── Altman Z-Score ──────────────────────────────────────────────────────────

export function calculateAltmanZ(financials: StockFinancials): AltmanZResult {
  const f = financials;

  // The original five-variable Z (with asset-turnover X5) was calibrated on
  // public manufacturers. Everything else is read with Altman's Z″, the
  // four-variable model he estimated without the turnover term so it would
  // travel to non-manufacturers and emerging markets.
  const manufacturingSectors = ['Basic Materials', 'Industrials', 'Energy', 'Utilities'];
  const isManufacturing = f.sector && manufacturingSectors.includes(f.sector);
  const model: AltmanZResult['model'] = isManufacturing ? 'original' : 'modified';

  const ta = f.totalAssets;
  const wc = f.workingCapital;
  const re = f.retainedEarnings;
  const ebit = valuationBasis(f).operatingIncome;
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
  // X4: original Z uses MARKET value of equity; Z″ uses BOOK value of equity.
  // Both over total liabilities.
  const eqHist = f.fundamentalsHistory.stockholdersEquity;
  const bookEquity = eqHist.length ? eqHist[eqHist.length - 1].value
    : (f.bookValue !== null && f.sharesOutstanding !== null ? f.bookValue * f.sharesOutstanding : null);
  const equityForX4 = model === 'original' ? mc : bookEquity;
  const x4 = tl && tl > 0 && equityForX4 ? equityForX4 / tl : null;
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

// ─── Dividend discount model (two-stage) ─────────────────────────────────────

/** Years the dividend grows at its own rate before fading to stable growth. */
const DDM_HIGH_GROWTH_YEARS = 5;
/** Years the fade to stable growth takes. */
const DDM_FADE_YEARS = 5;
/** No dividend compounds faster than this for five years on a mature payer. */
const DDM_MAX_GROWTH = 0.15;

/**
 * Two-stage dividend discount model: the dividend grows at its own five-year
 * rate (else the consensus EPS growth, else stable growth) for five years, fades
 * to stable growth over the next five, and is capitalised there with Gordon's
 * formula. A single-stage Gordon model capped every payer at the risk-free rate
 * from year one, which priced a company raising its dividend 10 % a year as if
 * it were a bond.
 */
export function calculateDDM(financials: StockFinancials, marketRates?: MarketRates): DDMResult {
  const rates = marketRates ?? FALLBACK_RATES;
  const dy = toFiniteNumber(financials.dividendYield);
  const price = financials.price;
  const requiredReturn = costOfEquity(financials, rates);
  const gT = Math.max(0, terminalGrowth(rates));
  const none = (isApplicable: boolean, dps: number | null = null, g: number | null = null): DDMResult => ({
    fairValue: null, dividendPerShare: dps, dividendGrowthRate: g, terminalGrowthRate: gT, requiredReturn, isApplicable,
  });

  if (dy === null || dy <= 0 || dy > 0.15) return none(false);
  const dps = price * dy;
  const own = toFiniteNumber(financials.dividendGrowthRate5Y) ?? forwardEpsGrowth(financials) ?? gT;
  const g = clamp(own, 0, DDM_MAX_GROWTH);
  if (requiredReturn <= gT + 0.01) return none(true, dps, g);

  let d = dps;
  let pv = 0;
  const years = DDM_HIGH_GROWTH_YEARS + DDM_FADE_YEARS;
  for (let t = 1; t <= years; t++) {
    const growth = t <= DDM_HIGH_GROWTH_YEARS ? g
      : g + (gT - g) * ((t - DDM_HIGH_GROWTH_YEARS) / DDM_FADE_YEARS);
    d *= 1 + growth;
    pv += d / Math.pow(1 + requiredReturn, t);
  }
  const terminal = (d * (1 + gT)) / (requiredReturn - gT);
  const fairValue = pv + terminal / Math.pow(1 + requiredReturn, years);

  if (!isPlausibleFairValue(fairValue, price)) return none(true, dps, g);
  return { fairValue, dividendPerShare: dps, dividendGrowthRate: g, terminalGrowthRate: gT, requiredReturn, isApplicable: true };
}

// ─── Earnings Power Value (Greenwald) ────────────────────────────────────────

/** Fiscal years the sustainable margin is averaged over. */
const EPV_MARGIN_YEARS = 5;

/**
 * Greenwald's earnings power value: what today's business is worth with no
 * growth at all — sustainable operating profit after tax, capitalised at the
 * cost of capital, plus the balance sheet's net cash and investments.
 *
 * "Sustainable" is the average operating margin of the last five fiscal years
 * applied to today's revenue, in both directions. The old version only ever
 * lifted a depressed year, so a cyclical at its peak had its peak capitalised
 * for ever; averaging over a cycle is what Greenwald's normalisation is for.
 * Tax is the marginal rate a mature firm pays, not the year's effective one.
 */
export function calculateEPV(financials: StockFinancials, marketRates?: MarketRates): EPVResult {
  const rates = marketRates ?? FALLBACK_RATES;
  const b = valuationBasis(financials);
  const r = wacc(financials, b, rates);
  const taxRate = Math.max(b.taxRate, b.marginalTaxRate);
  const margins = b.operatingMargins.slice(-EPV_MARGIN_YEARS);
  const current = b.operatingIncome !== null && b.revenue !== null && b.revenue > 0 ? b.operatingIncome / b.revenue : null;
  const normalizedMargin = margins.length >= 2 ? mean(margins) : current;
  const none: EPVResult = {
    fairValue: null, normalizedEbit: null, normalizedMargin, taxRate, wacc: r, marginOfSafety: null,
  };

  if (borrowsToLend(financials) || b.revenue === null || b.revenue <= 0 || normalizedMargin === null || normalizedMargin <= 0) {
    return none;
  }
  const normalizedEbit = normalizedMargin * b.revenue;
  const epv = (normalizedEbit * (1 - taxRate)) / r;
  const fairValue = equityPerShare(epv, b);
  if (fairValue === null || !isPlausibleFairValue(fairValue, b.price)) return { ...none, normalizedEbit };
  return {
    fairValue, normalizedEbit, normalizedMargin, taxRate, wacc: r,
    marginOfSafety: (fairValue - b.price) / b.price,
  };
}

// ─── Residual income / excess return model ───────────────────────────────────

/** Years the return on equity takes to settle at its terminal level. */
const RIM_FADE_YEARS = 10;

/**
 * Share of today's excess return on equity a franchise keeps for good. Excess
 * returns are competed away, but not all of them: a bank's deposit franchise or
 * an insurer's underwriting discipline is why it trades above book in the first
 * place. Half is the base case — Dechow, Hutton and Sloan (1999) measured
 * abnormal earnings persisting at about 0.6 a year, and a franchise that kept
 * nothing would make every bank worth its book.
 */
const RIM_DURABLE_EXCESS = 0.5;

/** Returns on equity above this are a balance sheet run down by buybacks, not a return. */
const RIM_MAX_ROE = 0.40;

/**
 * Sustainable return on equity: normalised earnings over common equity, averaged
 * with the fiscal years the statements show, so one good or bad year does not
 * set a perpetuity.
 */
function sustainableRoe(f: StockFinancials, b: ValuationBasis): number | null {
  const equity = new Map((f.fundamentalsHistory.stockholdersEquity ?? []).map((p) => [p.year, p.value]));
  const years = b.earningsHistory
    .filter((p) => (equity.get(p.year) ?? 0) > 0)
    .slice(-3)
    .map((p) => p.value / (equity.get(p.year) as number));
  const now = b.earnings !== null && b.equity !== null && b.equity > 0 ? b.earnings / b.equity : null;
  const all = now !== null ? [...years, now] : years;
  const roe = mean(all);
  return roe === null ? null : clamp(roe, -0.2, RIM_MAX_ROE);
}

/**
 * The excess return model: book value plus the present value of the returns
 * earned above the cost of equity on it.
 *
 *   value = BV₀ + Σ (ROEₜ − kₑ) · BVₜ₋₁ / (1 + kₑ)ᵗ + terminal
 *
 * ROE moves in a straight line from its sustainable level to kₑ plus the
 * durable half of today's excess over ten years, book grows by the retained
 * share of earnings, and the residual income left in year eleven is capitalised
 * as a perpetuity at stable growth. A firm earning less than its cost of equity
 * converges to exactly it — it either improves or shrinks.
 *
 * This is how banks and insurers are valued: book value is their operating
 * capital, and free cash flow to the firm describes nothing about them. The old
 * version stopped excess returns dead after year five with nothing after, and
 * so priced every good bank at little above its book.
 */
export function calculateRIM(financials: StockFinancials, marketRates?: MarketRates): RIMResult {
  const rates = marketRates ?? FALLBACK_RATES;
  const b = valuationBasis(financials);
  const ke = costOfEquity(financials, rates);
  const gT = Math.max(0, terminalGrowth(rates));
  const bv0 = b.equity !== null && b.dilutedShares !== null && b.dilutedShares > 0 ? b.equity / b.dilutedShares : null;
  const roe0 = sustainableRoe(financials, b);
  const none = (isApplicable = false): RIMResult => ({
    fairValue: null, costOfEquity: ke, sustainableRoe: roe0, terminalRoe: null,
    excessReturn: roe0 !== null ? roe0 - ke : null, bookValuePerShare: bv0, marginOfSafety: null, isApplicable,
  });
  if (bv0 === null || bv0 <= 0 || roe0 === null || ke <= gT + 0.01) return none();

  const roeT = ke + RIM_DURABLE_EXCESS * Math.max(0, roe0 - ke);
  const payout = clamp(toFiniteNumber(financials.payoutRatio) ?? 0.3, 0, 1);
  let bv = bv0;
  let pv = 0;
  for (let t = 1; t <= RIM_FADE_YEARS; t++) {
    const roe = roe0 + (roeT - roe0) * (t / RIM_FADE_YEARS);
    pv += ((roe - ke) * bv) / Math.pow(1 + ke, t);
    bv *= 1 + roe * (1 - payout);
  }
  const residual = (roeT - ke) * bv;
  const terminal = residual / (ke - gT);
  const fairValue = bv0 + pv + terminal / Math.pow(1 + ke, RIM_FADE_YEARS);

  if (!isPlausibleFairValue(fairValue, b.price)) return { ...none(), terminalRoe: roeT };
  return {
    fairValue, costOfEquity: ke, sustainableRoe: roe0, terminalRoe: roeT, excessReturn: roe0 - ke,
    bookValuePerShare: bv0, marginOfSafety: (fairValue - b.price) / b.price, isApplicable: true,
  };
}

// ─── Net current asset value (Graham net-net) ────────────────────────────────

export function calculateNCAV(financials: StockFinancials): NCAVResult {
  const ca = financials.totalCurrentAssets;
  const tl = financials.totalLiabilities;
  const b = valuationBasis(financials);
  const shares = b.shares;

  if (ca === null || tl === null || !shares || shares <= 0 || ca <= tl) {
    return { ncavPerShare: null, buyThreshold: null, marginOfSafety: null, isApplicable: false };
  }
  const ncavPerShare = (ca - tl) / shares;
  const buyThreshold = (2 / 3) * ncavPerShare;
  if (!isPlausibleFairValue(ncavPerShare, b.price)) {
    return { ncavPerShare: null, buyThreshold: null, marginOfSafety: null, isApplicable: false };
  }
  return { ncavPerShare, buyThreshold, marginOfSafety: (ncavPerShare - b.price) / b.price, isApplicable: true };
}

// ─── Peer-multiples fair value ───────────────────────────────────────────────

/** The fundamental each peer multiple prices — the unit a multiple gets its vote in. */
const FUNDAMENTAL_PRICED: Record<PeerMultiplesEntry['metric'], string> = {
  pe: 'earnings', evEbitda: 'ebitda', evRevenue: 'revenue', priceSales: 'revenue', priceFCF: 'cash flow', pb: 'book value',
};

/**
 * The multiples that describe a lender. Enterprise value, EBITDA, sales and
 * free cash flow all treat debt as financing, which for a bank it is not — its
 * peers are priced on earnings and on book.
 */
const LENDER_MULTIPLES = new Set<PeerMultiplesEntry['metric']>(['pe', 'pb']);

export function calculatePeerMultiples(
  financials: StockFinancials,
  sectorMedians: SectorMedians | null,
): PeerMultiplesResult {
  const empty = (): PeerMultiplesResult => ({
    byMultiple: [], medianFairPrice: null, meanFairPrice: null,
    count: 0, peerCount: sectorMedians?.peerCount ?? 0, marginOfSafety: null,
  });
  if (!sectorMedians) return empty();

  const b = valuationBasis(financials);
  const shares = b.shares;
  if (shares === null || shares <= 0) return empty();
  // Peers' enterprise values are market cap plus debt less cash, so ours is too.
  const netDebt = (financials.totalDebt ?? 0) - (financials.totalCash ?? 0);
  const price = b.price;
  const lender = borrowsToLend(financials);

  const entries: PeerMultiplesEntry[] = [];
  const push = (metric: PeerMultiplesEntry['metric'], own: number | null, peer: number | null, fairPrice: (own: number, peer: number) => number) => {
    if (lender && !LENDER_MULTIPLES.has(metric)) return;
    if (own !== null && own > 0 && peer !== null && peer > 0) {
      entries.push({ metric, ownMetric: own, sectorMedian: peer, fairPrice: fairPrice(own, peer) });
    }
  };

  push('pe', financials.eps, sectorMedians.pe, (eps, pe) => pe * eps);
  push('evEbitda', financials.ebitda, sectorMedians.evToEbitda, (e, m) => (m * e - netDebt) / shares);
  push('evRevenue', financials.revenue, sectorMedians.evToRevenue, (rev, m) => (m * rev - netDebt) / shares);
  push('priceFCF', b.freeCashFlow, sectorMedians.priceToFCF, (fcf, m) => (m * fcf) / shares);
  push('priceSales', financials.revenue, sectorMedians.priceToSales, (rev, m) => (m * rev) / shares);
  push('pb', b.bookValuePerShare, sectorMedians.pb, (bv, m) => m * bv);

  // Drop per-multiple outliers (a unit mismatch in one input, not a valuation).
  for (const e of entries) {
    if (!isPlausibleFairValue(e.fairPrice, price)) e.fairPrice = null;
  }
  if (entries.length === 0) return empty();

  const fairs = entries.map((e) => e.fairPrice).filter((x): x is number => x !== null && Number.isFinite(x));

  // One vote per fundamental: EV/Revenue and P/S price the same line of the
  // income statement, and counting both gave revenue two of six votes.
  const byFundamental = new Map<string, number[]>();
  for (const e of entries) {
    if (e.fairPrice === null || !Number.isFinite(e.fairPrice)) continue;
    const key = FUNDAMENTAL_PRICED[e.metric];
    byFundamental.set(key, [...(byFundamental.get(key) ?? []), e.fairPrice]);
  }
  const votes = [...byFundamental.values()].map((prices) => median(prices)!);
  const medianFP = median(votes);
  const meanFP = mean(votes);

  return {
    byMultiple: entries,
    medianFairPrice: medianFP,
    meanFairPrice: meanFP,
    count: fairs.length,
    peerCount: sectorMedians.peerCount ?? 0,
    marginOfSafety: medianFP !== null ? (medianFP - price) / price : null,
  };
}

// ─── Sortino ratio ───────────────────────────────────────────────────────────

export function calculateSortino(financials: StockFinancials, riskFreeRate = FALLBACK_RATES.riskFreeRate): SortinoResult {
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
  // Standard Sortino downside deviation: RMS of below-target returns over the
  // FULL period count (above-target months contribute 0), annualised by √12.
  const meanSquared = negativeExcess.reduce((s, r) => s + r * r, 0) / negativeExcess.length;
  const downsideDeviation = Math.sqrt(meanSquared) * Math.sqrt(12);

  if (downsideDeviation === 0) {
    return {
      ratio: null, annualReturn, downsideDeviation: 0, riskFreeRate,
      interpretation: annualReturn >= riskFreeRate ? 'excellent' : 'acceptable',
    };
  }
  const ratio = (annualReturn - riskFreeRate) / downsideDeviation;
  const interpretation: SortinoResult['interpretation'] =
    ratio >= 2   ? 'excellent'   :
    ratio >= 1   ? 'good'        :
    ratio >= 0.5 ? 'acceptable'  :
    ratio >= 0   ? 'poor'        :
                   'very poor';
  return { ratio, annualReturn, downsideDeviation, riskFreeRate, interpretation };
}

// ─── Beneish M-Score ─────────────────────────────────────────────────────────

/**
 * Beneish's eight indices, each this year against last on the same basis: the
 * newest fiscal year against the one before. The current side used to read the
 * trailing twelve months, so for a company nine months into a new year the
 * sales index measured close to two years of growth against one — Ondas'
 * 24.2 was 7.05 on a like-for-like basis, and three companies sat in the grey
 * zone that were clean.
 */
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

  const revenue = latestValue(f.fundamentalsHistory.revenue) ?? f.revenue;
  const grossProfit = latestValue(f.fundamentalsHistory.grossProfit) ?? f.grossProfit;

  const gm0 = py.revenue && py.revenue > 0 && py.grossProfit !== null ? py.grossProfit / py.revenue : null;
  const gm1 = revenue && revenue > 0 && grossProfit !== null ? grossProfit / revenue : null;
  const gmi = gm0 !== null && gm1 !== null && gm1 > 0 ? gm0 / gm1 : null;

  const sgi = py.revenue && py.revenue > 0 && revenue ? revenue / py.revenue : null;

  // TATA = (net income − cash from operations) / total assets, annual.
  const niSeries  = f.fundamentalsHistory.netIncome;
  const niAnnual  = niSeries.length ? niSeries[niSeries.length - 1].value : f.netIncome;
  const ocfAnnual = f.operatingCashFlowAnnual ?? f.operatingCashFlow;
  const tata = niAnnual !== null && ocfAnnual !== null ? (niAnnual - ocfAnnual) / f.totalAssets : null;

  const lev1 = f.longTermDebt !== null && f.totalCurrentLiabilities !== null
    ? (f.longTermDebt + f.totalCurrentLiabilities) / f.totalAssets : null;
  const lev0 = py.longTermDebt !== null && py.currentLiabilities !== null && py.totalAssets && py.totalAssets > 0
    ? (py.longTermDebt + py.currentLiabilities) / py.totalAssets : null;
  const lvgi = lev1 !== null && lev0 !== null && lev0 > 0 ? lev1 / lev0 : null;

  const dsr1 = f.receivables !== null && revenue && revenue > 0 ? f.receivables / revenue : null;
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

  const sgai1 = f.sga !== null && revenue && revenue > 0 ? f.sga / revenue : null;
  const sgai0 = py.sga !== null && py.revenue && py.revenue > 0 ? py.sga / py.revenue : null;
  const sgai = sgai1 !== null && sgai0 !== null && sgai0 > 0 ? sgai1 / sgai0 : null;

  const indices = [dsri, gmi, aqi, sgi, depi, sgai, tata, lvgi];
  const computed = indices.filter((x) => x !== null).length;

  // Require at least 5 of 8 indices — the coefficients assume all eight, and
  // substituting 1.0 for too many pushes the score toward "manipulator".
  if (computed < 5) {
    return { score: null, probability: 'unknown', dsri, gmi, aqi, sgi, depi, sgai, tata, lvgi, variablesComputed: computed };
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

/**
 * Sales growth beyond what the M-Score was fitted on. Beneish estimated the
 * model on filers whose manipulator sample averaged an SGI near 1.6; the
 * coefficient on SGI is +0.892 and the function is linear, so far enough out
 * the growth term alone decides the score. That is extrapolation, not a
 * measurement, and it should not cap a verdict.
 */
export const BENEISH_SGI_OUT_OF_SAMPLE = 3.0;

/** Growth at which the SGI term starts to dominate the score. */
export const BENEISH_SGI_GROWTH = 1.3;

export type BeneishReading =
  | 'not-applicable'    // a lender: receivables are the product, not a by-product
  | 'unavailable'       // too few variables to compute
  | 'clean'
  | 'grey'
  | 'flagged'           // elevated, and the accruals back it up
  | 'growth-explained'  // elevated, but earnings are cash-backed and sales grew
  | 'extrapolated';     // elevated, but the model was evaluated out of sample

/**
 * What the M-Score is actually saying about this company — the one reading the
 * composite's confidence, the balance-sheet criterion and the conviction cap all
 * consume, so no two of them can disagree about whether the same number is
 * evidence. The composite used to halve its confidence on the raw flag while
 * the scorer had already explained it as growth.
 *
 * The variable that separates growth from manipulation is TATA — total
 * accruals over assets. Cash at or above earnings is the opposite of the
 * pattern the score exists to find.
 */
export function beneishReading(f: StockFinancials, b: BeneishResult): BeneishReading {
  if (borrowsToLend(f)) return 'not-applicable';
  if (b.variablesComputed < 4) return 'unavailable';
  if (b.probability === 'unlikely manipulator') return 'clean';
  if (b.probability !== 'likely manipulator') return 'grey';
  const sgi = toFiniteNumber(b.sgi);
  const tata = toFiniteNumber(b.tata);
  if (sgi !== null && sgi > BENEISH_SGI_OUT_OF_SAMPLE) return 'extrapolated';
  if (sgi !== null && sgi > BENEISH_SGI_GROWTH && tata !== null && tata <= 0) return 'growth-explained';
  return 'flagged';
}

// ─── Interest coverage ───────────────────────────────────────────────────────

/**
 * Operating income over interest. Without debt there is nothing to cover and a
 * profitable firm is `excellent`; with debt but no interest reported — Apple
 * stopped breaking it out — there is no ratio to read, and the answer is
 * `unknown`, not the best score on the scale.
 */
export function calculateInterestCoverage(financials: StockFinancials): InterestCoverageResult {
  const ebit = valuationBasis(financials).operatingIncome;
  const interest = toFiniteNumber(financials.interestExpense);
  const debt = toFiniteNumber(financials.totalDebt) ?? 0;

  if (interest === null || interest === 0) {
    if (debt > 0) return { ratio: null, interpretation: 'unknown' };
    if (ebit !== null && ebit > 0) return { ratio: null, interpretation: 'excellent' };
    if (ebit !== null && ebit < 0) return { ratio: null, interpretation: 'critical' };
    return { ratio: null, interpretation: 'unknown' };
  }
  if (ebit === null) return { ratio: null, interpretation: 'unknown' };

  const ratio = ebit / Math.abs(interest);
  const interpretation: InterestCoverageResult['interpretation'] =
    ratio >= 8   ? 'excellent' :
    ratio >= 4   ? 'good'      :
    ratio >= 2   ? 'fair'      :
    ratio >= 1   ? 'poor'      :
                   'critical';
  return { ratio, interpretation };
}

// ─── Composite fair value ────────────────────────────────────────────────────

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
 * The composite contributor that is not one of our models. Named here so the
 * scorer can take it back out without matching on a string literal.
 */
export const ANALYST_CONSENSUS_MODEL = 'Analyst Consensus';

/** The composite's relative lens, named for the scorer that reads it separately. */
export const PEER_MULTIPLES_MODEL = 'Peer Multiples';

/** Return on equity above which book value is no longer the capital that earns the profits. */
export const BOOK_ANCHOR_MAX_ROE = 0.40;

/** Payout ratio below which the dividend is not how the firm distributes value. */
export const DDM_MIN_PAYOUT = 0.40;

/**
 * How far from the price one model may pull the fair value. A model saying five
 * times the price is not five times as informative as one saying twice, and a
 * median over two numbers is their mean — so a single wild DCF next to a sober
 * peer multiple used to carry the pair to +200 %. Values are capped at these
 * multiples of the price before they are aggregated, and the aggregation is in
 * logs, where 0.5× and 2× are equally far from the price.
 */
export const FAIR_VALUE_BOUNDS = { low: 0.4, high: 2.5 } as const;

/**
 * How much a model's voice counts. Not taste: each discount is a known weakness.
 *   - a DCF whose value sits over 85 % in the terminal value, or whose growth
 *     path is not a forecast anyone published, rests on one assumption;
 *   - peer medians from fewer than five peers are a handful of anecdotes;
 *   - Lynch's rule is a rule of thumb, applied to one year of growth.
 */
export const MODEL_WEIGHT = { full: 1, discounted: 0.5 } as const;

function dcfWeight(dcf: DCFResult): number {
  const fragile = (dcf.terminalShare ?? 0) > 0.85 || dcf.growthSource !== 'analyst consensus';
  return fragile ? MODEL_WEIGHT.discounted : MODEL_WEIGHT.full;
}

/**
 * Weighted median of log fair values. The median of the logs is the geometric
 * middle of the models, where a model at half the price and one at twice it
 * balance; weights let a fragile model count half without dropping it.
 */
function weightedLogMedian(points: { x: number; w: number }[]): number | null {
  const pts = points.filter((p) => Number.isFinite(p.x) && p.w > 0).sort((a, b) => a.x - b.x);
  if (pts.length === 0) return null;
  const total = pts.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    acc += pts[i].w;
    if (Math.abs(acc - total / 2) < 1e-12 && i + 1 < pts.length) return (pts[i].x + pts[i + 1].x) / 2;
    if (acc > total / 2) return pts[i].x;
  }
  return pts[pts.length - 1].x;
}

/**
 * The fair value a set of models agrees on, in logs, where half and twice the
 * price are equally far from it.
 *
 * Published (no `bounds`): the weighted median of what the models said — a
 * reader's middle, which one wild model cannot move.
 *
 * Scored (`bounds` given): each model first held within the bounds of the price,
 * then the weighted *mean* of the logs. A median over two models is whichever
 * weighs more — Intel's half-weight DCF at 0.06× next to a full-weight peer
 * multiple at 1.93× came out as the peer multiple alone — while the bounded
 * mean lets both speak and neither shout: no single model can move the result
 * by more than the bounds allow.
 */
export function aggregateFairValue(
  price: number, models: CompositeContributor[], bounds: { low: number; high: number } | null = null,
): number | null {
  if (!(price > 0) || models.length === 0) return null;
  const points = models.map((m) => ({ x: Math.log(m.fairValue / price), w: m.weight ?? MODEL_WEIGHT.full }));
  if (!bounds) {
    const x = weightedLogMedian(points);
    return x === null ? null : price * Math.exp(x);
  }
  const lo = Math.log(bounds.low), hi = Math.log(bounds.high);
  const total = points.reduce((s, p) => s + p.w, 0);
  if (!(total > 0)) return null;
  const x = points.reduce((s, p) => s + p.w * clamp(p.x, lo, hi), 0) / total;
  return price * Math.exp(x);
}

function tierStats(price: number, models: CompositeContributor[]): CompositeTier {
  const fvs = models.map((m) => m.fairValue).sort((a, b) => a - b);
  if (fvs.length === 0) {
    return { median: null, mean: null, p25: null, p75: null, min: null, max: null, marginOfSafety: null, models };
  }
  const med = aggregateFairValue(price, models);
  const mos = med !== null && Number.isFinite(price) && price > 0 ? (med - price) / price : null;
  return {
    median: med,
    mean: mean(fvs),
    p25: quantileSorted(fvs, 0.25),
    p75: quantileSorted(fvs, 0.75),
    min: fvs[0],
    max: fvs[fvs.length - 1],
    marginOfSafety: mos,
    models,
  };
}

/**
 * Tiered composite fair value.
 *
 *   PRIMARY (headline): market-aligned, growth-aware — the DCF, peer multiples,
 *   Peter Lynch and the analyst consensus; for a bank, insurer or lender the
 *   excess return model takes the DCF's place, because book value is its
 *   operating capital.
 *
 *   CONSERVATIVE (value lens): no-growth or asset-based — Graham's number and
 *   V*, EPV, the excess return model and the dividend model — each only where
 *   it describes the company.
 *
 * Each tier's median is a weighted median of log values, so a model at half the
 * price and one at twice it balance, and a fragile model counts half.
 */
export function calculateCompositeFairValue(financials: StockFinancials, inputs: CompositeInputs): CompositeFairValueResult {
  const price = financials.price;
  const lender = borrowsToLend(financials);
  const roe = financials.roe;
  const bookNotAnchor = !lender && roe !== null && Number.isFinite(roe) && roe > BOOK_ANCHOR_MAX_ROE
    ? `ROE ${(roe * 100).toFixed(0)} % — book value is not the capital base (buybacks or a capital-light model), so a book-anchored value measures the balance sheet, not the business`
    : undefined;
  const payout = financials.payoutRatio;
  const tokenDividend = inputs.ddm.isApplicable && payout !== null && Number.isFinite(payout) && payout < DDM_MIN_PAYOUT
    ? `Payout ${(payout * 100).toFixed(0)} % — the dividend is not how this firm distributes value, so a dividend-only value understates it`
    : undefined;
  const rimExcessTooNegative = !lender && inputs.rim.excessReturn !== null && inputs.rim.excessReturn < -0.03;
  const fcffInapplicable = lender ? `Not applicable — ${LENDER_NOTE}` : undefined;

  const primary: CompositeContributor[]      = [];
  const conservative: CompositeContributor[] = [];
  const excluded: CompositeExclusion[]       = [];
  let primaryModels = 0;

  function add(
    tier: 'primary' | 'conservative', name: string, value: number | null, missingReason: string,
    skipReason?: string, weight: number = MODEL_WEIGHT.full,
  ) {
    if (tier === 'primary') primaryModels++;
    if (skipReason) {
      excluded.push({ name, reason: skipReason });
      return;
    }
    if (value !== null && Number.isFinite(value) && value > 0) {
      (tier === 'primary' ? primary : conservative).push({ name, fairValue: value, weight });
    } else {
      excluded.push({ name, reason: missingReason });
    }
  }

  // ── PRIMARY tier ──
  if (lender) {
    add('primary', 'Excess Return (RIM)', inputs.rim.fairValue, 'Requires positive book value and a return on equity');
  } else {
    add('primary', 'DCF (Revenue-Driven)', inputs.dcf.fairValue, inputs.dcf.assumptions, undefined, dcfWeight(inputs.dcf));
  }
  add('primary', PEER_MULTIPLES_MODEL, inputs.peerMultiples.medianFairPrice, 'No peer-group data', undefined,
    (inputs.peerMultiples.peerCount ?? 0) >= 5 ? MODEL_WEIGHT.full : MODEL_WEIGHT.discounted);
  add('primary', 'Peter Lynch', inputs.peterLynch.fairValue,
    'Requires positive earnings and 5–25 % consensus or three-year growth', undefined, MODEL_WEIGHT.discounted);
  // Analyst target = market consensus, treated as one more "model" for triangulation.
  primaryModels++;
  if (financials.targetMeanPrice !== null && Number.isFinite(financials.targetMeanPrice) && financials.targetMeanPrice > 0) {
    primary.push({ name: ANALYST_CONSENSUS_MODEL, fairValue: financials.targetMeanPrice, weight: MODEL_WEIGHT.full });
  } else {
    excluded.push({ name: ANALYST_CONSENSUS_MODEL, reason: 'No analyst coverage' });
  }

  // ── CONSERVATIVE tier ──
  add('conservative', 'Graham Number',     inputs.graham.grahamNumber,     'Requires positive EPS and book value', bookNotAnchor);
  add('conservative', 'Graham Revised V*', inputs.grahamRevised.fairValue, 'Requires positive EPS and growth');
  add('conservative', 'EPV (Greenwald)',   inputs.epv.fairValue,           'Requires a positive normalised operating margin', fcffInapplicable);
  if (!lender) {
    add('conservative', 'Excess Return (RIM)', inputs.rim.fairValue, 'Requires positive book value and a return on equity',
      bookNotAnchor ?? (rimExcessTooNegative
        ? `Sustainable ROE far below cost of equity (excess ${(inputs.rim.excessReturn! * 100).toFixed(1)}pp) — a book-anchored value understates a firm in a heavy investment phase`
        : undefined));
  }
  add('conservative', 'DDM (Two-Stage)',
    inputs.ddm.isApplicable ? inputs.ddm.fairValue : null,
    inputs.ddm.isApplicable ? 'Cost of equity barely above stable growth — model unstable' : 'No dividend',
    tokenDividend);

  const primaryTier      = tierStats(price, primary);
  const conservativeTier = tierStats(price, conservative);

  // Confidence (0-10) based on primary tier coverage + dispersion + Beneish.
  const coverageScore = (primary.length / primaryModels) * 5;
  const iqrRel = primaryTier.median && primaryTier.median > 0 && primaryTier.p25 !== null && primaryTier.p75 !== null
    ? (primaryTier.p75 - primaryTier.p25) / primaryTier.median
    : 1.0;
  const tightnessBonus =
    iqrRel < 0.15 ? 5 :
    iqrRel < 0.30 ? 4 :
    iqrRel < 0.50 ? 3 :
    iqrRel < 0.80 ? 2 : 1;
  let confidence = coverageScore + tightnessBonus;
  // Only a flag the accruals support halves it — see `beneishReading`.
  if (beneishReading(financials, inputs.beneish) === 'flagged') confidence /= 2;
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
