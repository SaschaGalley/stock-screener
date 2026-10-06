/**
 * The discounted cash flow model, built from revenue.
 *
 * The first DCF here grew this year's free cash flow at next year's consensus
 * *EPS* growth for five years and then faded it. Three things were wrong with
 * that, and all three showed on the watchlist:
 *
 *   - EPS growth is not cash-flow growth. It carries buybacks, tax changes and
 *     margin recoveries; Honeywell's consensus EPS grew 20 % on revenue up 2 %,
 *     and a DCF compounding that for five years priced it at 3.2× its share
 *     price.
 *   - A forecast it disliked was replaced by the past. A negative consensus was
 *     thrown away and a three-year historical CAGR took its place: Novo Nordisk,
 *     with analysts expecting earnings to fall, was compounded at 24 % a year and
 *     valued at 4.4× its price.
 *   - It jumped. The reinvestment the business made today was assumed for ten
 *     years, and then replaced overnight by the steady-state rate in the
 *     terminal value.
 *
 * So this one is built the way Damodaran builds his: revenue grows along the
 * consensus path and fades to the economy's rate, the operating margin moves
 * from where it is to where it can plausibly settle, taxes move to the marginal
 * rate, and growth is paid for with reinvestment at the firm's own
 * sales-to-capital ratio. Free cash flow is what is left — the model never
 * reads this year's free cash flow at all, so a capex spike or a working-capital
 * release cannot become a valuation. Stock compensation is a cost, because the
 * operating margin is after it.
 *
 * And it answers with a distribution rather than a number. Growth, the target
 * margin, capital efficiency, the discount rate and terminal growth are each
 * uncertain; 512 deterministic draws (`sampling.ts`) turn the one base case into
 * a range, and the share of that range above the price is the probability the
 * valuation pillar reads.
 */

import { MarketRates } from '../data/fred.js';
import { deNumber } from '../format.js';
import { Rating } from '../data/ratings.js';
import { DCFResult, ImpliedMargin, ReverseDCFResult, SectorMedians, StockFinancials } from '../types.js';
import { toFiniteNumber } from '../utils/num.js';
import { ValuationBasis, bridgeNetDebt, equityPerShare, valuationBasis } from './basis.js';
import { MATURE_MAX_DEBT_SHARE, adjustedBeta, betaPrior, costOfDebt, terminalGrowth, wacc } from './cost-of-capital.js';
import { haltonPoints, normalQuantile, quantileSorted } from './sampling.js';

// ── Shape of the forecast ────────────────────────────────────────────────────

/** Years forecast explicitly before the terminal value. */
export const FORECAST_YEARS = 10;

/**
 * How much of a growth rate's excess over the economy survives each year once
 * the consensus runs out. Revenue growth is less persistent than it looks — Chan,
 * Karceski and Lakonishok (2003) found almost none beyond what chance produces —
 * and 0.75 gives it a half-life of about two and a half years. The fade is
 * rescaled to land exactly on terminal growth in the final year, so there is no
 * step into the terminal value.
 */
export const GROWTH_PERSISTENCE = 0.75;

/** Years the operating margin takes to reach its target. */
export const MARGIN_CONVERGENCE_YEARS = 5;

/** Year after which the discount rate moves towards a mature firm's (beta 1). */
const MATURITY_STARTS_AFTER = 5;

/**
 * Bounds on the growth the path starts from. The upper one is Damodaran's
 * "extreme growth" boundary; below −30 % a year a firm is being wound down, and
 * no going-concern model describes that.
 */
export const GROWTH_BOUNDS = { min: -0.30, max: 0.60 } as const;

/**
 * Sales-to-capital: revenue added per unit of capital reinvested. Below 0.5 is a
 * utility building plants; above 5 a firm growing on its customers' money
 * (subscriptions paid in advance), where the ratio says more about working
 * capital than about the business. 1.5 is roughly the market-wide figure in
 * Damodaran's industry data, for firms with no history to measure it from.
 */
export const SALES_TO_CAPITAL = { min: 0.5, max: 5, fallback: 1.5 } as const;

/**
 * Peers needed before their median margin is a credible destination. Thin
 * groups produced medians from −53 % to 1.5 % for companies nobody would call
 * loss-making.
 */
export const MIN_PEERS_FOR_MARGIN = 5;

/**
 * How far below-peer margins close the gap by default. A firm that earns less
 * than its industry may get there — that is the bull case — or may be the
 * reason the industry earns what it does. Halfway is the base case; the
 * simulation spreads around it.
 */
export const PEER_MARGIN_CONVERGENCE = 0.5;

/**
 * How far the terminal discount rate must clear terminal growth. At a one-point
 * spread a perpetuity is worth a hundred years of its cash flow and the whole
 * valuation is that one difference; at two points it is fifty, which is where
 * any stable-growth model is already being asked a lot. Growth is lowered to
 * keep the spread rather than the model abandoned.
 */
export const MIN_TERMINAL_SPREAD = 0.02;

/**
 * Stable growth never exceeds the risk-free rate (no firm outgrows the economy
 * for ever), and a firm the consensus has growing more slowly than that does not
 * accelerate into perpetuity either: its own second-year rate is the ceiling.
 * Half the risk-free rate is the floor — nominal growth with roughly inflation
 * in it — so a firm in a bad year is not valued as one shrinking for ever.
 */
export const TERMINAL_GROWTH_FLOOR = 0.5;

// ── Uncertainty ──────────────────────────────────────────────────────────────

/** Draws in the simulation; deterministic, so every run and every re-score agree. */
export const SIMULATION_DRAWS = 512;

/**
 * How uncertain each input is, one standard deviation.
 *
 *   - growth: a quarter of the consensus rate plus three points — a 30 %
 *     grower might do 20 or 40, a 5 % one 2 or 8;
 *   - target margin: ±20 % of itself, multiplicatively;
 *   - sales-to-capital: ±30 %, multiplicatively — it is the least observed input;
 *   - discount rate: ±1 point — about the spread between reasonable betas and
 *     premiums;
 *   - terminal growth: anywhere from the risk-free rate down to 1.5 points
 *     below it, never above.
 */
export const UNCERTAINTY = {
  growthRelative: 0.25,
  growthAbsolute: 0.03,
  margin: 0.20,
  salesToCapital: 0.30,
  discountRate: 0.01,
  terminalGrowthRange: 0.015,
} as const;

const HALTON = haltonPoints(SIMULATION_DRAWS, 5);

// ── The model ────────────────────────────────────────────────────────────────

export interface DcfAssumptions {
  /** Trailing twelve-month revenue the path starts from. */
  revenue: number;
  growth1: number;
  growth2: number;
  terminalGrowth: number;
  marginNow: number;
  marginTarget: number;
  taxNow: number;
  taxTerminal: number;
  salesToCapital: number;
  /** Return on new capital kept in perpetuity is capped here (peer median / own ROIC); null for no cap. */
  roicCap: number | null;
  discountRate: number;
  terminalDiscountRate: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Revenue growth for each forecast year. */
export function growthPath(a: Pick<DcfAssumptions, 'growth1' | 'growth2' | 'terminalGrowth'>): number[] {
  const fadeYears = FORECAST_YEARS - 2;
  const end = Math.pow(GROWTH_PERSISTENCE, fadeYears);
  const path = [a.growth1, a.growth2];
  for (let k = 1; k <= fadeYears; k++) {
    const w = (Math.pow(GROWTH_PERSISTENCE, k) - end) / (1 - end);
    path.push(a.terminalGrowth + (a.growth2 - a.terminalGrowth) * w);
  }
  return path;
}

function marginAt(a: DcfAssumptions, year: number): number {
  const left = Math.max(0, 1 - year / MARGIN_CONVERGENCE_YEARS);
  return a.marginTarget + (a.marginNow - a.marginTarget) * left;
}

function taxAt(a: DcfAssumptions, year: number): number {
  return a.taxNow + (a.taxTerminal - a.taxNow) * (year / FORECAST_YEARS);
}

function discountRateAt(a: DcfAssumptions, year: number): number {
  if (year <= MATURITY_STARTS_AFTER) return a.discountRate;
  const t = (year - MATURITY_STARTS_AFTER) / (FORECAST_YEARS - MATURITY_STARTS_AFTER);
  return a.discountRate + (a.terminalDiscountRate - a.discountRate) * t;
}

export interface FirmValue {
  enterpriseValue: number;
  terminalValue: number;
  /** Free cash flow to the firm per forecast year. */
  cashFlows: number[];
  terminalRoic: number;
  terminalReinvestmentRate: number;
  /** Share of enterprise value in the terminal value. */
  terminalShare: number;
}

/**
 * Enterprise value under one set of assumptions: ten years of free cash flow to
 * the firm plus a terminal value, discounted mid-year — cash arrives through a
 * year, not on its last day.
 *
 * Terminal value pays for its own growth: a firm growing at g on new capital
 * that earns ROIC reinvests g ÷ ROIC of its operating profit, so
 *
 *   TV = NOPAT₁₁ × (1 − g / ROIC) / (r − g)
 *
 * with ROIC the model's own marginal return (target margin after tax × sales to
 * capital), capped at what the peers keep and floored at the discount rate: a
 * firm earning less on new capital would stop investing rather than destroy
 * value forever.
 */
export function valueFirm(a: DcfAssumptions): FirmValue | null {
  if (!(a.terminalDiscountRate > a.terminalGrowth + MIN_TERMINAL_SPREAD / 4)) return null;
  if (!(a.revenue > 0) || !(a.salesToCapital > 0)) return null;
  const growth = growthPath(a);
  let revenue = a.revenue;
  let factor = 1;
  let pv = 0;
  const cashFlows: number[] = [];
  for (let year = 1; year <= FORECAST_YEARS; year++) {
    const previous = revenue;
    revenue = previous * (1 + growth[year - 1]);
    const ebit = revenue * marginAt(a, year);
    const nopat = ebit > 0 ? ebit * (1 - taxAt(a, year)) : ebit;
    const reinvestment = (revenue - previous) / a.salesToCapital;
    const fcff = nopat - reinvestment;
    const r = discountRateAt(a, year);
    factor *= 1 + r;
    pv += (fcff / factor) * Math.sqrt(1 + r);
    cashFlows.push(fcff);
  }
  const implied = a.marginTarget * (1 - a.taxTerminal) * a.salesToCapital;
  const roic = Math.max(a.terminalDiscountRate, Math.min(implied, a.roicCap ?? implied));
  const reinvestmentRate = a.terminalGrowth / roic;
  const nopatNext = revenue * (1 + a.terminalGrowth) * a.marginTarget * (1 - a.taxTerminal);
  const terminalValue = (nopatNext * (1 - reinvestmentRate)) / (a.terminalDiscountRate - a.terminalGrowth);
  const pvTerminal = (terminalValue / factor) * Math.sqrt(1 + a.terminalDiscountRate);
  const enterpriseValue = pv + pvTerminal;
  return {
    enterpriseValue,
    terminalValue,
    cashFlows,
    terminalRoic: roic,
    terminalReinvestmentRate: reinvestmentRate,
    terminalShare: enterpriseValue !== 0 ? pvTerminal / enterpriseValue : 1,
  };
}

/** Value per share under one set of assumptions, or null where the model has no answer. */
function perShare(a: DcfAssumptions, b: ValuationBasis): number | null {
  const v = valueFirm(a);
  return v ? equityPerShare(v.enterpriseValue, b) : null;
}

export interface DcfDistribution {
  p10: number; p25: number; p50: number; p75: number; p90: number;
  /** Share of the draws worth more than the price. */
  probabilityAbovePrice: number;
  draws: number;
}

/**
 * The same model over the uncertainty in its inputs. The growth shock is shared
 * by both consensus years, so a draw is a story (a faster or slower grower), not
 * a zig-zag. Draws where the model has no answer — a discount rate pushed below
 * terminal growth — are left out rather than counted either way.
 */
export function simulate(a: DcfAssumptions, b: ValuationBasis): DcfDistribution | null {
  const u = UNCERTAINTY;
  const values: number[] = [];
  for (const [ug, um, us, ur, ut] of HALTON) {
    const zg = normalQuantile(ug), zm = normalQuantile(um), zs = normalQuantile(us), zr = normalQuantile(ur);
    const shock = (g: number) => clamp(g + zg * (u.growthRelative * Math.abs(g) + u.growthAbsolute), GROWTH_BOUNDS.min, GROWTH_BOUNDS.max);
    const draw: DcfAssumptions = {
      ...a,
      growth1: shock(a.growth1),
      growth2: shock(a.growth2),
      marginTarget: a.marginTarget * Math.exp(u.margin * zm),
      salesToCapital: clamp(a.salesToCapital * Math.exp(u.salesToCapital * zs), SALES_TO_CAPITAL.min, SALES_TO_CAPITAL.max),
      discountRate: a.discountRate + u.discountRate * zr,
      terminalDiscountRate: a.terminalDiscountRate + u.discountRate * zr,
      terminalGrowth: a.terminalGrowth - u.terminalGrowthRange * ut,
    };
    const v = perShare(draw, b);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  if (values.length < SIMULATION_DRAWS / 2) return null;
  values.sort((x, y) => x - y);
  const q = (p: number) => quantileSorted(values, p) as number;
  return {
    p10: q(0.10), p25: q(0.25), p50: q(0.50), p75: q(0.75), p90: q(0.90),
    probabilityAbovePrice: values.filter((v) => v > b.price).length / values.length,
    draws: values.length,
  };
}

/**
 * Bisection for the input at which value per share equals the price. Needs the
 * value to rise with the input across the bracket; where it does not bracket
 * the price the answer is outside the range and is reported as the edge it hit.
 */
function solveFor(
  valueAt: (x: number) => number | null, target: number, lo: number, hi: number,
): { value: number; edge: 'low' | 'high' | null } | null {
  const vLo = valueAt(lo), vHi = valueAt(hi);
  if (vLo === null || vHi === null || vHi < vLo) return null;
  if (vLo >= target) return { value: lo, edge: 'low' };
  if (vHi <= target) return { value: hi, edge: 'high' };
  let a = lo, b = hi;
  for (let i = 0; i < 80 && b - a > 1e-6; i++) {
    const mid = (a + b) / 2;
    const v = valueAt(mid);
    if (v === null) return null;
    if (v < target) a = mid; else b = mid;
  }
  return { value: (a + b) / 2, edge: null };
}

// ── Inputs from a company ────────────────────────────────────────────────────

/**
 * Banks, insurers and brokers borrow as their business, not to finance it: debt
 * is their raw material, interest their cost of goods. Free cash flow to the
 * firm and a WACC mean nothing for them, and FCFF models return numbers anyway —
 * NU at 6× its price and BRK-B at 16× in September 2026. Payment networks
 * ("Credit Services") are fee businesses and stay in.
 */
const DEBT_AS_RAW_MATERIAL = [/^Banks\b/, /^Insurance - /, /^Capital Markets$/, /^Mortgage Finance$/];

export function isBalanceSheetFinancial(f: StockFinancials): boolean {
  return f.industry != null && DEBT_AS_RAW_MATERIAL.some((re) => re.test(f.industry!));
}

/**
 * Interest expense at or above this share of revenue is a cost of revenue.
 *
 * The industry list above catches banks, insurers and brokers by name, but not
 * a lender filed under a label it shares with something else entirely: SoFi and
 * Mastercard are both "Credit Services", and one of them funds a loan book
 * while the other runs a payment network. Debt does not separate them —
 * 0.80× revenue against 0.70×. Interest does, by a factor of thirteen: SoFi
 * pays 27 % of revenue in interest, Mastercard 2 %, Berkshire 1 %, Nu 54 %.
 */
const LENDER_INTEREST_SHARE = 0.15;

/**
 * Does this company borrow in order to lend?
 *
 * The question matters wherever a model assumes receivables are a by-product of
 * selling something, or that debt finances the business rather than being its
 * inventory. For a lender the loan book *is* the product, so the Beneish
 * M-Score's receivables and accrual terms describe the business rather than
 * detect anything about it, and free cash flow to the firm — where the loan
 * book's growth is an operating outflow — describes nothing at all.
 */
export function borrowsToLend(f: StockFinancials): boolean {
  if (isBalanceSheetFinancial(f)) return true;
  if (f.sector !== 'Financial Services') return false;
  const revenue = toFiniteNumber(f.revenue);
  const interest = toFiniteNumber(f.interestExpense);
  return revenue !== null && revenue > 0 && interest !== null
    && Math.abs(interest) / revenue >= LENDER_INTEREST_SHARE;
}

export const LENDER_NOTE =
  'Banken, Versicherer, Broker und Kreditgeber leihen sich Geld als Geschäft, deshalb beschreiben Free Cashflow und WACC sie nicht';

export type GrowthSource = 'analyst consensus' | 'trailing twelve months' | 'steady state';

export interface DcfInputs {
  basis: ValuationBasis;
  assumptions: DcfAssumptions;
  beta: number;
  costOfDebt: { rate: number; rating: Rating | null } | null;
  growthSource: GrowthSource;
  targetMarginSource: 'current' | 'own history' | 'consensus' | 'halfway to peers';
  salesToCapitalSource: 'history' | 'balance sheet' | 'default';
  /** The best margin shown or earned by peers — the yardstick the market-implied margin is read against. */
  achievableMargin: { value: number; basis: 'current' | 'history' | 'peers' } | null;
  /**
   * Why the forward model has no answer although the inputs exist — a firm with
   * no profitable record or peer group to converge to. The reverse solve still
   * runs: a revenue path is enough to ask what margin the price requires.
   */
  forwardSkip: string | null;
}

function consensusRevenueGrowth(f: StockFinancials, period: '0y' | '+1y'): number | null {
  const e = (f.earningsEstimates ?? []).find((x) => x.period === period);
  return toFiniteNumber(e?.revenueGrowth);
}

function mean(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/**
 * Revenue per unit of the capital that runs the business: tangible common equity
 * plus the debt the cash flows are before, less the cash and investments the
 * operating income does not earn on. The ratio the business has built up over its life is
 * the steadiest guide to what its next dollar of revenue will cost — the
 * marginal one, measured as operating profit less free cash flow, came out at
 * the top of the range for any firm whose cash flow ran ahead of its profit for
 * a few years, and gave a power producer the capital needs of a software house.
 * A firm with next to no operating capital (buybacks, customer prepayments)
 * sits at the top of the range; one without a balance sheet at the market-wide
 * figure.
 */
function salesToCapital(f: StockFinancials, b: ValuationBasis): { value: number; source: DcfInputs['salesToCapitalSource'] } {
  if (b.revenue === null || b.revenue <= 0) return { value: SALES_TO_CAPITAL.fallback, source: 'default' };
  // Tangible where the payload has it: goodwill is what an acquisition cost, not
  // what the next dollar of organic revenue will — AMD's Xilinx goodwill made
  // its growth look three times as capital-hungry as a fabless designer's is.
  const equity = toFiniteNumber(f.tangibleBookValue) ?? b.equity;
  if (equity !== null) {
    const capital = equity + b.debt - b.cash - b.nonOperatingAssets;
    const value = capital > 0 ? b.revenue / capital : SALES_TO_CAPITAL.max;
    return { value: clamp(value, SALES_TO_CAPITAL.min, SALES_TO_CAPITAL.max), source: 'balance sheet' };
  }
  const fcf = new Map(b.freeCashFlowHistory.map((p) => [p.year, p.value]));
  const opInc = new Map(b.operatingIncomeHistory.map((p) => [p.year, p.value]));
  const years = b.revenueHistory.filter((p) => fcf.has(p.year) && opInc.has(p.year)).slice(-4);
  if (years.length >= 3) {
    const added = years[years.length - 1].value - years[0].value;
    let reinvested = 0;
    for (const y of years.slice(1)) reinvested += (opInc.get(y.year) as number) * (1 - b.taxRate) - (fcf.get(y.year) as number);
    if (added > 0 && reinvested > 0) {
      return { value: clamp(added / reinvested, SALES_TO_CAPITAL.min, SALES_TO_CAPITAL.max), source: 'history' };
    }
  }
  return { value: SALES_TO_CAPITAL.fallback, source: 'default' };
}

/**
 * The operating margin the consensus implies for next fiscal year.
 *
 * Built from growth rates alone. Yahoo quotes the EPS estimates of a foreign
 * listing in whatever unit the analysts use — Alibaba's in yuan per ADS,
 * Sanofi's in euros per ordinary share (half an ADR), TSMC's in dollars per ADR
 * — so a forecast EPS times shares over forecast revenue came out at a 103 %
 * net margin for Alibaba. Growth rates carry no unit: earnings growing faster
 * than revenue is a margin widening by exactly the ratio of the two, and two
 * years of that, applied to the newest fiscal year's operating margin, is where
 * the analysts expect it to be.
 *
 * Where analysts expect a margin the business has not yet shown — Siemens
 * Energy's recovery — that is information the statements cannot have; where
 * they expect one to shrink — Novo Nordisk's — the destination should know
 * that too.
 */
function consensusMargin(f: StockFinancials, b: ValuationBasis): number | null {
  const byPeriod = (p: string) => (f.earningsEstimates ?? []).find((e) => e.period === p);
  const e0 = byPeriod('0y');
  const e1 = byPeriod('+1y');
  const fyMargin = b.operatingMargins.length > 0 ? b.operatingMargins[b.operatingMargins.length - 1] : null;
  if (!e0 || !e1 || fyMargin === null || fyMargin <= 0) return null;
  // A rate off a loss is not a rate — both years' EPS must be positive.
  if (!((e0.epsEstimate ?? 0) > 0) || !((e1.epsEstimate ?? 0) > 0)) return null;
  const rates = [e0.epsGrowth, e0.revenueGrowth, e1.epsGrowth, e1.revenueGrowth].map(toFiniteNumber);
  if (rates.some((r) => r === null || r <= -1)) return null;
  const [ge0, gr0, ge1, gr1] = rates as number[];
  const factor = ((1 + ge0) / (1 + gr0)) * ((1 + ge1) / (1 + gr1));
  return clamp(fyMargin * Math.min(factor, CONSENSUS_MARGIN_MAX_FACTOR), 0, CONSENSUS_MARGIN_CAP);
}

/**
 * Two years of consensus may double a margin, no more. Beyond that the EPS
 * growth rate is measuring off a depressed base — Vistra's implied operating
 * margin went from 11 % to 36 % on one such year — not a business re-rating
 * its profitability.
 */
const CONSENSUS_MARGIN_MAX_FACTOR = 2;

/** No business settles above this operating margin. */
const CONSENSUS_MARGIN_CAP = 0.6;

/**
 * Everything the forward model, the simulation and the reverse solves share,
 * computed once so they cannot disagree about what they value — or a reason
 * there is nothing to value.
 */
export function dcfInputs(
  f: StockFinancials, rates: MarketRates, peers: SectorMedians | null,
): { inputs: DcfInputs } | { skip: string } {
  if (borrowsToLend(f)) return { skip: `DCF nicht anwendbar — ${LENDER_NOTE}.` };
  const b = valuationBasis(f);
  if (b.revenue === null || b.revenue <= 0) return { skip: 'DCF nicht anwendbar — kein Umsatz, auf dem die Prognose aufbauen könnte.' };
  if (b.dilutedShares === null || b.dilutedShares <= 0 || !(b.price > 0)) {
    return { skip: 'DCF nicht anwendbar — keine Aktienzahl, auf die sich der Wert verteilen ließe.' };
  }
  if (b.operatingIncome === null) return { skip: 'DCF nicht anwendbar — kein operatives Ergebnis.' };

  const rf = terminalGrowth(rates);
  const c0 = consensusRevenueGrowth(f, '0y');
  const c1 = consensusRevenueGrowth(f, '+1y');
  const trailing = b.revenueGrowth;
  const [g1, g2, growthSource]: [number, number, GrowthSource] =
    c0 !== null || c1 !== null ? [c0 ?? (c1 as number), c1 ?? (c0 as number), 'analyst consensus']
    : trailing !== null ? [trailing, trailing, 'trailing twelve months']
    : [rf, rf, 'steady state'];

  const marginNow = b.operatingIncome / b.revenue;
  const recent = b.operatingMargins.slice(-3);
  const marginHistory = recent.length >= 2 ? mean(recent) : null;
  const peerMargin = (peers?.peerCount ?? 0) >= MIN_PEERS_FOR_MARGIN ? toFiniteNumber(peers?.operatingMargin) : null;

  // Where analysts forecast the margin, that is the destination, up or down.
  // Without a forecast: back to the firm's own record in full, and towards the
  // industry halfway.
  const expected = consensusMargin(f, b);
  let marginTarget = marginNow;
  let targetMarginSource: DcfInputs['targetMarginSource'] = 'current';
  if (expected !== null) {
    marginTarget = expected;
    targetMarginSource = 'consensus';
  } else {
    if (marginHistory !== null && marginHistory > marginTarget) {
      marginTarget = marginHistory;
      targetMarginSource = 'own history';
    }
    if (peerMargin !== null && peerMargin > marginTarget) {
      marginTarget = marginTarget + PEER_MARGIN_CONVERGENCE * (peerMargin - marginTarget);
      targetMarginSource = 'halfway to peers';
    }
  }

  const forwardSkip = marginTarget > 0 ? null
    : `DCF nicht anwendbar — operative Marge ${deNumber(marginNow * 100, 1)} % ohne profitable Jahre oder Peers, auf die sie zulaufen könnte.`;

  const beta = adjustedBeta(f.beta, betaPrior(peers));
  const r = wacc(f, b, rates, beta);
  const rT = wacc(f, b, rates, 1, MATURE_MAX_DEBT_SHARE);
  const gT = Math.min(rf, Math.max(clamp(g2, GROWTH_BOUNDS.min, GROWTH_BOUNDS.max), TERMINAL_GROWTH_FLOOR * rf), rT - MIN_TERMINAL_SPREAD);
  const s2c = salesToCapital(f, b);
  const ownRoic = toFiniteNumber(f.roic);
  const peerRoic = toFiniteNumber(peers?.roic);
  const caps = [ownRoic, peerRoic].filter((x): x is number => x !== null && x > 0);

  return {
    inputs: {
      basis: b,
      beta,
      costOfDebt: b.debt > 0 ? costOfDebt(f, b, rates) : null,
      growthSource,
      targetMarginSource,
      salesToCapitalSource: s2c.source,
      achievableMargin: achievableMargin(marginNow, marginHistory, peerMargin),
      forwardSkip,
      assumptions: {
        revenue: b.revenue,
        growth1: clamp(g1, GROWTH_BOUNDS.min, GROWTH_BOUNDS.max),
        growth2: clamp(g2, GROWTH_BOUNDS.min, GROWTH_BOUNDS.max),
        terminalGrowth: gT,
        marginNow,
        marginTarget,
        taxNow: b.taxRate,
        // Effective rates converge up to the statutory one as deferrals unwind;
        // one already paying more keeps paying it.
        taxTerminal: Math.max(b.taxRate, b.marginalTaxRate),
        salesToCapital: s2c.value,
        roicCap: caps.length > 0 ? Math.min(...caps) : null,
        discountRate: r,
        terminalDiscountRate: rT,
      },
    },
  };
}

/**
 * Plausible only between 0.02× and 30× the price. Outside that almost always
 * signals a data problem — a share-unit mismatch, a currency read twice —
 * rather than a valuation insight.
 */
export function isPlausibleFairValue(fv: number | null | undefined, price: number): boolean {
  if (fv === null || fv === undefined || !Number.isFinite(fv) || fv <= 0) return false;
  if (!Number.isFinite(price) || price <= 0) return false;
  const r = fv / price;
  return r >= 0.02 && r <= 30;
}

// The texts below are German sentences, and their numbers German too.
const pct = (x: number) => `${deNumber(x * 100, 1)} %`;

const GROWTH_SOURCE_DE: Record<GrowthSource, string> = {
  'analyst consensus': 'Konsens', 'trailing twelve months': 'letzte zwölf Monate', 'steady state': 'eingeschwungen',
};
const MARGIN_SOURCE_DE: Record<DcfInputs['targetMarginSource'], string> = {
  current: 'heutige', 'own history': 'eigene Jahre', consensus: 'Konsens', 'halfway to peers': 'halb zu den Peers',
};
const S2C_SOURCE_DE: Record<DcfInputs['salesToCapitalSource'], string> = {
  history: 'Historie', 'balance sheet': 'Bilanz', default: 'Standardwert',
};
const BASIS_DE: Record<NonNullable<DcfInputs['achievableMargin']>['basis'], string> = {
  current: 'heute', history: 'eigene Jahre', peers: 'Peers',
};

type DcfBase = Pick<DCFResult,
  'fairValue' | 'fairValueBear' | 'fairValueBull' | 'distribution' | 'riskFreeRate' | 'equityRiskPremium' | 'premiumAdjustment'
  | 'countryRiskPremium' | 'terminalGrowthRate' | 'forecastYears' | 'projectedFCFs' | 'terminalValue'
  | 'enterpriseValue' | 'terminalShare'>;

/** A DCF with nothing to say, saying why. */
function calculateDCF_skipped(
  f: StockFinancials, peers: SectorMedians | null, reason: string, base: DcfBase,
): DCFResult {
  return {
    ...base,
    discountRate: null, terminalDiscountRate: null, costOfDebt: null, syntheticRating: null,
    beta: adjustedBeta(f.beta, betaPrior(peers)), revenueBase: null, growthYear1: null, growthYear2: null, growthSource: null,
    operatingMargin: null, targetMargin: null, targetMarginSource: null,
    salesToCapital: null, salesToCapitalSource: null, taxRate: null, terminalTaxRate: null,
    terminalRoic: null, terminalReinvestmentRate: null, netDebt: null,
    assumptions: reason,
  };
}

/**
 * The base-case value per share alone, without the simulation — for solving
 * the premium at which the model prices a stock at its price, a few dozen
 * evaluations per stock.
 */
export function baseFairValue(f: StockFinancials, rates: MarketRates, peers: SectorMedians | null = null): number | null {
  const built = dcfInputs(f, rates, peers);
  if ('skip' in built || built.inputs.forwardSkip) return null;
  const value = valueFirm(built.inputs.assumptions);
  return value ? equityPerShare(value.enterpriseValue, built.inputs.basis) : null;
}

export function calculateDCF(
  f: StockFinancials, rates: MarketRates, peers: SectorMedians | null = null,
): DCFResult {
  const built = dcfInputs(f, rates, peers);
  const base: DcfBase = {
    fairValue: null, fairValueBear: null, fairValueBull: null, distribution: null,
    riskFreeRate: rates.riskFreeRate, equityRiskPremium: rates.equityRiskPremium,
    premiumAdjustment: rates.premiumAdjustment ?? 0,
    countryRiskPremium: toFiniteNumber(f.countryRiskPremium),
    terminalGrowthRate: terminalGrowth(rates), forecastYears: FORECAST_YEARS,
    projectedFCFs: [], terminalValue: null, enterpriseValue: null, terminalShare: null,
  };
  if ('skip' in built) return calculateDCF_skipped(f, peers, built.skip, base);
  const { inputs } = built;
  base.terminalGrowthRate = inputs.assumptions.terminalGrowth;
  if (inputs.forwardSkip) return calculateDCF_skipped(f, peers, inputs.forwardSkip, base);
  const a = inputs.assumptions;
  const b = inputs.basis;
  const value = valueFirm(a);
  const fair = value ? equityPerShare(value.enterpriseValue, b) : null;
  const distribution = simulate(a, b);
  // Only an implausibly *high* value is a data anomaly now that shares and
  // currencies are reconciled upstream. A value near nothing is the model
  // saying the forecast's cash flows barely cover the capital growth needs —
  // Intel's foundry build-out — and throwing it away left a peer multiple to
  // speak for the whole valuation.
  const plausible = fair !== null && fair > 0 && fair <= b.price * 30;

  const debtNote = inputs.costOfDebt
    ? `, Fremdkapital ${pct(inputs.costOfDebt.rate)} ${inputs.costOfDebt.rating ?? 'ohne Rating → BBB'}` : '';
  const assumptions = plausible
    ? `Umsatz ${pct(a.growth1)} / ${pct(a.growth2)} (${GROWTH_SOURCE_DE[inputs.growthSource]}), auslaufend auf ${pct(a.terminalGrowth)} bis Jahr ${FORECAST_YEARS} · `
      + `operative Marge ${pct(a.marginNow)} → ${pct(a.marginTarget)} (${MARGIN_SOURCE_DE[inputs.targetMarginSource]}) · `
      + `Umsatz/Kapital ${deNumber(a.salesToCapital, 2)} (${S2C_SOURCE_DE[inputs.salesToCapitalSource]}) · Steuer ${pct(a.taxNow)} → ${pct(a.taxTerminal)} · `
      + `WACC ${pct(a.discountRate)} → ${pct(a.terminalDiscountRate)} (β ${deNumber(inputs.beta, 2)} bereinigt, risikolos ${pct(rates.riskFreeRate)}, `
      + `Risikoprämie ${pct(rates.equityRiskPremium)}${rates.premiumAdjustment ? ` (Markt ${pct(rates.equityRiskPremium - rates.premiumAdjustment)}, Modell ${rates.premiumAdjustment > 0 ? '+' : '−'}${pct(Math.abs(rates.premiumAdjustment))})` : ''}`
      + `${f.countryRiskPremium ? ` + Länderrisiko ${pct(f.countryRiskPremium)}` : ''}${debtNote}) · `
      + `ROIC am Ende ${pct(value!.terminalRoic)}`
    : fair !== null && fair <= 0
      ? 'Kein Eigenkapitalwert bei diesen Annahmen — die prognostizierten Cashflows decken die Schulden und die fürs Wachstum nötigen Investitionen nicht.'
      : 'DCF-Wert unplausibel gegenüber dem Kurs — vermutlich ein Datenfehler je Aktie.';

  return {
    ...base,
    fairValue: plausible ? fair : null,
    fairValueBear: plausible && distribution && distribution.p10 > 0 ? distribution.p10 : null,
    fairValueBull: plausible && distribution ? distribution.p90 : null,
    distribution: plausible || (fair !== null && fair <= 0) ? distribution : null,
    discountRate: a.discountRate,
    terminalDiscountRate: a.terminalDiscountRate,
    costOfDebt: inputs.costOfDebt?.rate ?? null,
    syntheticRating: inputs.costOfDebt?.rating ?? null,
    beta: inputs.beta,
    revenueBase: a.revenue,
    growthYear1: a.growth1,
    growthYear2: a.growth2,
    growthSource: inputs.growthSource,
    operatingMargin: a.marginNow,
    targetMargin: a.marginTarget,
    targetMarginSource: inputs.targetMarginSource,
    salesToCapital: a.salesToCapital,
    salesToCapitalSource: inputs.salesToCapitalSource,
    taxRate: a.taxNow,
    terminalTaxRate: a.taxTerminal,
    terminalRoic: value?.terminalRoic ?? null,
    terminalReinvestmentRate: value?.terminalReinvestmentRate ?? null,
    projectedFCFs: value?.cashFlows ?? [],
    terminalValue: value?.terminalValue ?? null,
    enterpriseValue: value?.enterpriseValue ?? null,
    terminalShare: value?.terminalShare ?? null,
    netDebt: bridgeNetDebt(b),
    assumptions,
  };
}

// ── What the price requires ──────────────────────────────────────────────────

/**
 * The same model run backwards, twice.
 *
 * **The margin the price requires.** Hold the consensus revenue path, the
 * reinvestment and the discount rate, and solve for the operating margin the
 * business has to settle at for today's price to be fair. Then hold it against
 * the best margin already shown — today's, its own recent years', or its peers'
 * median — because what counts as demanding depends on the business: 30 % is a
 * stretch for a retailer and a step back for a payments network. Works for
 * pre-profit firms, which have a revenue path even without a profit.
 *
 * **The growth the price requires.** Hold the margin path and solve for the
 * growth in the first two years instead; beside the consensus it says whether
 * the market is asking for more than the analysts expect.
 */
export function calculateReverseDCF(
  f: StockFinancials, rates: MarketRates, peers: SectorMedians | null = null,
): ReverseDCFResult {
  const built = dcfInputs(f, rates, peers);
  if ('skip' in built) {
    return {
      impliedGrowthRate: null, consensusGrowth: null, discountRate: null, terminalGrowthRate: terminalGrowth(rates),
      isPossible: false, interpretation: `Nicht berechenbar — ${built.skip.replace(/^DCF nicht anwendbar — /, '')}`, impliedMargin: null,
    };
  }
  const { inputs } = built;
  const a = inputs.assumptions;
  const b = inputs.basis;
  const gT = a.terminalGrowth;
  const impliedMargin = impliedMarginFor(inputs);
  if (inputs.forwardSkip) {
    return {
      impliedGrowthRate: null, consensusGrowth: null, discountRate: a.discountRate, terminalGrowthRate: gT,
      isPossible: false, interpretation: 'Ohne eine Marge, mit der es verdient würde, lässt sich kein Wachstum auflösen — siehe die Marge, die der Kurs verlangt.',
      impliedMargin,
    };
  }

  const growth = solveFor((g) => perShare({ ...a, growth1: g, growth2: g }, b), b.price, GROWTH_BOUNDS.min, 1.5);
  const g = growth?.value ?? null;
  const consensus = inputs.growthSource === 'analyst consensus' ? a.growth2 : null;
  const interpretation = g === null
    ? 'Kein Wachstum erklärt den Kurs — bei dieser Marge und diesen Investitionen ändert Wachstum den Wert nicht.'
    : growth!.edge === 'low' ? `Der Markt preist einen Umsatzrückgang von mehr als ${pct(-GROWTH_BOUNDS.min)} im Jahr ein — ein Krisenpreis.`
    : growth!.edge === 'high' ? 'Der Markt preist mehr als 150 % Umsatzwachstum im Jahr ein — jenseits dessen, was das Modell abbilden kann.'
    : `Der Markt preist ${pct(g)} Umsatzwachstum für zwei Jahre ein, auslaufend auf ${pct(gT)}`
      + (consensus !== null ? ` — der Konsens erwartet ${pct(consensus)}.` : '.');

  return {
    impliedGrowthRate: g,
    consensusGrowth: consensus,
    discountRate: a.discountRate,
    terminalGrowthRate: gT,
    isPossible: g !== null,
    interpretation,
    impliedMargin,
  };
}

/** Ratio of required to achievable margin at which the price needs a step change. */
const DEMANDING = { holds: 1, keeps: 1.25, expands: 1.75 } as const;

function impliedMarginFor(inputs: DcfInputs): ImpliedMargin | null {
  const a = inputs.assumptions;
  const b = inputs.basis;
  const solved = solveFor((m) => perShare({ ...a, marginTarget: m }, b), b.price, -0.5, 0.95);
  if (!solved) return null;
  const required = solved.value;
  const yardstick = inputs.achievableMargin;
  const ratio = yardstick && required > 0 ? required / yardstick.value : null;
  const times = ratio !== null ? `Das ${deNumber(ratio, 1)}-fache der besten gezeigten Marge (${pct(yardstick!.value)}, ${BASIS_DE[yardstick!.basis]})` : '';
  const interpretation =
    required <= 0         ? 'Der Kurs hält selbst ohne operativen Gewinn — der Markt gibt dem Geschäft selbst wenig Wert.'
    : solved.edge === 'high' ? 'Der Kurs verlangt eine operative Marge über 95 % — die verdient kein Geschäft.'
    : ratio === null      ? `Der Kurs verlangt ${pct(required)} operative Marge, und das Geschäft hat noch keinen Gewinn gezeigt, an dem sie sich messen ließe.`
    : ratio <= DEMANDING.holds   ? `${times} — der Kurs hält auch, wenn die Margen nachgeben.`
    : ratio <= DEMANDING.keeps   ? `${times} — der Kurs braucht, dass das Geschäft hält, was es verdient.`
    : ratio <= DEMANDING.expands ? `${times} — der Kurs braucht deutlich steigende Margen.`
    :                              `${times} — der Kurs braucht einen Sprung in der Profitabilität.`;
  return {
    requiredMargin: required,
    achievableMargin: yardstick?.value ?? null,
    achievableBasis: yardstick?.basis ?? null,
    ratio,
    revenueBase: a.revenue,
    revenueGrowth: a.growth2,
    growthSource: inputs.growthSource,
    discountRate: a.discountRate,
    interpretation,
  };
}

/** The best operating margin shown — today's, the recent years' average, or the peers' median. */
function achievableMargin(now: number, history: number | null, peers: number | null): DcfInputs['achievableMargin'] {
  return ([['current', now], ['history', history], ['peers', peers]] as const)
    .reduce<DcfInputs['achievableMargin']>((best, [basis, v]) =>
      v !== null && v > 0 && (best === null || v > best.value) ? { value: v, basis } : best, null);
}
