/**
 * What capital costs a company: its equity, its debt, and the blend of the two.
 *
 * Every rate-based model discounts with these, so they live in one place — the
 * DCF, EPV, the dividend and residual-income models all ask the same questions
 * and must not answer them differently.
 */

import { MarketRates } from '../data/fred.js';
import { Rating, ratingForCoverage, UNRATED } from '../data/ratings.js';
import { SectorMedians, StockFinancials } from '../types.js';
import { toFiniteNumber } from '../utils/num.js';
import { ValuationBasis } from './basis.js';

/**
 * A regression beta pulled a third of the way towards its prior.
 *
 * A five-year regression beta is a noisy estimate, and betas measured high or
 * low drift back in the next window — Blume (1971) measured the drift at about
 * a third, which is why every terminal quotes `0.67 × raw + 0.33`. Blume drifts
 * every stock towards the market's 1. Vasicek (1973) drifts it towards what is
 * known about stocks like it, and that is the prior here when there is a peer
 * group: the median of the peers' betas (`betaPrior`). A chipmaker measured at
 * 1.1 is more likely a 1.3 business on a quiet five years than a 1.0 one, and a
 * utility measured at 0.9 more likely a 0.6. A stock with no beta of its own
 * takes its peers' — the bottom-up beta, pure.
 *
 * The floor stays where it was. A regression beta near zero is usually a
 * listing that barely correlates with the index it is measured against — a
 * European pharma's ADR against the S&P 500 read 0.28 — rather than a business
 * with no market risk, and at 0.5 Sanofi was discounted at 7 %.
 */
export function adjustedBeta(raw: number | null | undefined, prior = 1): number {
  const b = toFiniteNumber(raw) ?? prior;
  return Math.max(BETA_FLOOR, Math.min(BETA_CAP, 0.67 * b + 0.33 * prior));
}

/** What a stock's beta is shrunk towards: its peers' median beta, else the market's 1. */
export function betaPrior(peers: SectorMedians | null | undefined): number {
  const b = toFiniteNumber(peers?.beta);
  return b !== null && b > 0 ? b : 1;
}

/** Bounds after adjustment: stale quotes and one-off spikes should not price a business. */
const BETA_FLOOR = 0.8;
const BETA_CAP = 2.0;

/**
 * CAPM cost of equity: the risk-free rate of the cash flows' currency plus beta
 * times the equity risk premium — Damodaran's implied premium measured on the
 * S&P 500, plus what the headquarters country adds over the United States.
 * Nu Holdings and MercadoLibre were discounted as if they operated in Ohio.
 */
export function costOfEquity(f: StockFinancials, rates: MarketRates, beta = adjustedBeta(f.beta)): number {
  return rates.riskFreeRate + beta * (rates.equityRiskPremium + (toFiniteNumber(f.countryRiskPremium) ?? 0));
}

/**
 * Pre-tax cost of debt: what the firm would pay to borrow today. Interest
 * coverage (operating income ÷ interest) gives the rating it would earn, the
 * live spread for that rating sits on top of the risk-free rate — see
 * `data/ratings.ts` — and a company in a riskier country pays its government's
 * default spread as well. Interest ÷ debt used to stand in for this, and
 * measured the coupon on debt issued years ago instead. `rating` is null when
 * there is nothing to rate on and the firm was priced as `UNRATED`.
 */
export function costOfDebt(
  f: StockFinancials, b: ValuationBasis, rates: MarketRates,
): { rate: number; rating: Rating | null } {
  const interest = toFiniteNumber(f.interestExpense);
  const rating = interest !== null && interest !== 0 && b.operatingIncome !== null
    ? ratingForCoverage(b.operatingIncome / Math.abs(interest))
    : null;
  return {
    rate: rates.riskFreeRate + rates.creditSpreads[rating ?? UNRATED] + (toFiniteNumber(f.countryDefaultSpread) ?? 0),
    rating,
  };
}

/**
 * Debt share of capital a mature firm is held to in the terminal rate. Cheap
 * after-tax debt pulls the blend down, and at Fresenius Medical's 50 % the
 * terminal WACC came to 6.8 % against 5.2 % stable growth — a perpetuity worth
 * 60 times its operating profit. A mature firm runs at roughly the market's
 * average leverage, not at whatever its balance sheet carries today.
 */
export const MATURE_MAX_DEBT_SHARE = 0.3;

/**
 * Weighted-average cost of capital, for discounting unlevered (firm-level) cash
 * flows before the equity bridge:
 *
 *   WACC = E/V·ke + D/V·kd·(1 − t)
 *
 * E is the market value of equity, D the debt the cash flows are before (see
 * `valuationBasis`), t the marginal rate — interest is deducted at the margin,
 * not at the average rate a group pays after its credits. Debt-free firms
 * collapse to the cost of equity. `beta` is the equity beta the blend is taken
 * at, `maxDebtShare` a ceiling on D/V: the DCF's terminal rate uses beta 1 and
 * `MATURE_MAX_DEBT_SHARE`.
 */
export function wacc(
  f: StockFinancials, b: ValuationBasis, rates: MarketRates, beta = adjustedBeta(f.beta), maxDebtShare = 1,
): number {
  const ke = costOfEquity(f, rates, beta);
  const E = toFiniteNumber(f.marketCap) ?? (b.shares !== null ? b.shares * b.price : 0);
  const D = b.debt;
  if (D <= 0 || !(E > 0)) return ke;
  const debtShare = Math.min(D / (E + D), maxDebtShare);
  return (1 - debtShare) * ke + debtShare * costOfDebt(f, b, rates).rate * (1 - b.marginalTaxRate);
}

/**
 * Stable growth, as an invariant rather than a constant.
 *
 * A firm growing forever faster than the economy eventually *becomes* the
 * economy, so terminal growth is capped at the risk-free rate — the market's
 * own estimate of long-run nominal growth, and the standard Damodaran ceiling.
 * The cap doubles as the default, and a caller-supplied rate is clamped rather
 * than trusted.
 */
export function terminalGrowth(rates: MarketRates, requested?: number): number {
  return Math.min(requested ?? rates.riskFreeRate, rates.riskFreeRate);
}
