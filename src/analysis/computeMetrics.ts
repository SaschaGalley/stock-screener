import { StockFinancials, SectorMedians } from '../types.js';
import { FALLBACK_RATES, MarketRates, ratesForCurrency } from '../data/fred.js';
import { modelPremiumAdjustment } from './calibration.js';
import {
  calculateDCF, calculateGraham, calculateRatios, calculateReverseDCF,
  calculatePeterLynch, calculateEVMultiples, calculateRuleOf40,
  calculateGrahamRevised, calculatePiotroski, calculateAltmanZ,
  calculateDDM, calculateEPV, calculateRIM, calculateNCAV,
  calculatePeerMultiples, calculateInterestCoverage, calculateSortino,
  calculateBeneish, calculateCompositeFairValue,
} from './metrics.js';
import { baseFairValue, borrowsToLend } from './dcf.js';
import { calculateHealthChecks } from './health.js';

export interface ComputedMetrics {
  dcf:              ReturnType<typeof calculateDCF>;
  grahamNumber:     ReturnType<typeof calculateGraham>;
  ratios:           ReturnType<typeof calculateRatios>;
  reverseDCF:       ReturnType<typeof calculateReverseDCF>;
  peterLynch:       ReturnType<typeof calculatePeterLynch>;
  evMultiples:      ReturnType<typeof calculateEVMultiples>;
  ruleOf40:         ReturnType<typeof calculateRuleOf40>;
  grahamRevised:    ReturnType<typeof calculateGrahamRevised>;
  piotroski:        ReturnType<typeof calculatePiotroski>;
  altmanZ:          ReturnType<typeof calculateAltmanZ>;
  ddm:              ReturnType<typeof calculateDDM>;
  epv:              ReturnType<typeof calculateEPV>;
  rim:              ReturnType<typeof calculateRIM>;
  ncav:             ReturnType<typeof calculateNCAV>;
  peerMultiples:    ReturnType<typeof calculatePeerMultiples>;
  interestCoverage: ReturnType<typeof calculateInterestCoverage>;
  sortino:          ReturnType<typeof calculateSortino>;
  beneish:          ReturnType<typeof calculateBeneish>;
  composite:        ReturnType<typeof calculateCompositeFairValue>;
  /** The balance sheet as plain checks, and the cash runway of a company that burns cash. */
  health:           ReturnType<typeof calculateHealthChecks>;
}

/**
 * The market's premium can go this low and no lower once the model's
 * adjustment is added: a year in which both fell together should not have the
 * DCF discount equities at the rate of a government bond.
 */
export const MIN_EQUITY_PREMIUM = 0.015;

/**
 * The rates the models price one stock with: the risk-free rate of the
 * currency its cash flows are in, net of the default spread its government
 * carries over the US, and the market's premium plus the model's adjustment
 * for the stock's group — its currency, and whether it lends
 * (`modelPremiumAdjustment`).
 */
export function modelRates(
  financials: StockFinancials, marketRates: MarketRates | null,
  adjustment = modelPremiumAdjustment(financials.tradingCurrency, borrowsToLend(financials)),
): MarketRates {
  const local = ratesForCurrency(marketRates ?? FALLBACK_RATES, financials.tradingCurrency, financials.currencyDefaultSpread ?? 0);
  const premium = Math.max(MIN_EQUITY_PREMIUM, local.equityRiskPremium + adjustment);
  return { ...local, equityRiskPremium: premium, premiumAdjustment: premium - local.equityRiskPremium };
}

/** How far either way the premium may be shifted in the search, and how finely. */
const PREMIUM_SEARCH = { range: 0.04, steps: 30 } as const;

/**
 * The shift of the market premium at which the model that carries a stock
 * values it at its price: the DCF's base case, and for a bank, insurer or
 * lender the excess return model, which takes the DCF's place in its headline
 * tier. A stock no shift within the range can price sits at the range's edge
 * rather than dropping out: the ones the model finds dearest are exactly the
 * ones that need the largest cut, and leaving them out pulled the median
 * towards zero. Null where that model has no value — a firm with no margin to
 * converge to, a lender without book value.
 */
export function impliedPremiumShift(inputs: {
  financials: StockFinancials; rates: MarketRates | null; sectorMedians: SectorMedians | null;
}): number | null {
  const { financials: f, rates, sectorMedians } = inputs;
  const price = f.price;
  if (typeof price !== 'number' || !(price > 0)) return null;
  const lender = borrowsToLend(f);
  const at = (shift: number) => {
    const r = modelRates(f, rates, shift);
    return lender ? calculateRIM(f, r, sectorMedians).fairValue : baseFairValue(f, r, sectorMedians);
  };
  let lo: number = -PREMIUM_SEARCH.range;
  let hi: number = PREMIUM_SEARCH.range;
  const vLo = at(lo);
  const vHi = at(hi);
  if (vLo === null || vHi === null) return null;
  // Value falls as the premium rises.
  if (vLo < price) return lo;
  if (vHi > price) return hi;
  for (let i = 0; i < PREMIUM_SEARCH.steps; i++) {
    const mid = (lo + hi) / 2;
    const v = at(mid);
    if (v === null) return null;
    if (v > price) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Run every valuation model on cached financials. Cheap (<10ms total). */
export function computeAllMetrics(
  financials:    StockFinancials,
  marketRates:   MarketRates | null,
  sectorMedians: SectorMedians | null,
): ComputedMetrics {
  // Discount in the currency the cash flows are in. Statements arrive converted
  // into the trading currency, so that is the currency whose yield applies —
  // net of the default spread its government carries over the US.
  const base = marketRates ?? FALLBACK_RATES;
  const rates = modelRates(financials, base);
  // Graham's Y is a corporate AAA yield: the dollar AAA spread over Treasuries,
  // on top of this currency's own government rate.
  const aaaYield = rates.riskFreeRate + (base.aaaBondYield - base.riskFreeRate);

  const dcf              = calculateDCF(financials, rates, sectorMedians);
  const grahamNumber     = calculateGraham(financials);
  const ratios           = calculateRatios(financials);
  const reverseDCF       = calculateReverseDCF(financials, rates, sectorMedians);
  const peterLynch       = calculatePeterLynch(financials);
  const evMultiples      = calculateEVMultiples(financials);
  const ruleOf40         = calculateRuleOf40(financials);
  const grahamRevised    = calculateGrahamRevised(financials, aaaYield);
  const piotroski        = calculatePiotroski(financials);
  const altmanZ          = calculateAltmanZ(financials);
  // One beta for every model that prices equity: shrunk towards the peers'.
  const ddm              = calculateDDM(financials, rates, sectorMedians);
  const epv              = calculateEPV(financials, rates, sectorMedians);
  const rim              = calculateRIM(financials, rates, sectorMedians);
  const ncav             = calculateNCAV(financials);
  const peerMultiples    = calculatePeerMultiples(financials, sectorMedians);
  const interestCoverage = calculateInterestCoverage(financials);
  const sortino          = calculateSortino(financials, rates.riskFreeRate);
  const beneish          = calculateBeneish(financials);
  const composite        = calculateCompositeFairValue(financials, {
    dcf, graham: grahamNumber, grahamRevised, peterLynch, ddm, epv, rim,
    peerMultiples, beneish,
  });

  return {
    dcf, grahamNumber, ratios, reverseDCF, peterLynch, evMultiples,
    ruleOf40, grahamRevised, piotroski, altmanZ, ddm, epv, rim, ncav,
    peerMultiples, interestCoverage, sortino, beneish, composite,
    health: calculateHealthChecks(financials, interestCoverage),
  };
}
