import { StockFinancials, SectorMedians } from '../types.js';
import { MarketRates } from '../data/fred.js';
import {
  calculateDCF, calculateGraham, calculateRatios, calculateReverseDCF,
  calculatePeterLynch, calculateEVMultiples, calculateRuleOf40,
  calculateGrahamRevised, calculatePiotroski, calculateAltmanZ,
  calculateDDM, calculateEPV, calculateRIM, calculateNCAV,
  calculatePeerMultiples, calculateInterestCoverage, calculateSortino,
  calculateBeneish, calculateCompositeFairValue,
} from './metrics.js';

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
}

/** Run every valuation model on cached financials. Cheap (<10ms total). */
export function computeAllMetrics(
  financials:    StockFinancials,
  marketRates:   MarketRates | null,
  sectorMedians: SectorMedians | null,
): ComputedMetrics {
  const rates = marketRates ?? undefined;

  const dcf              = calculateDCF(financials, rates);
  const grahamNumber     = calculateGraham(financials);
  const ratios           = calculateRatios(financials);
  const reverseDCF       = calculateReverseDCF(financials, rates);
  const peterLynch       = calculatePeterLynch(financials);
  const evMultiples      = calculateEVMultiples(financials);
  const ruleOf40         = calculateRuleOf40(financials);
  const grahamRevised    = calculateGrahamRevised(financials, marketRates?.aaaBondYield);
  const piotroski        = calculatePiotroski(financials);
  const altmanZ          = calculateAltmanZ(financials);
  const ddm              = calculateDDM(financials, marketRates?.riskFreeRate);
  const epv              = calculateEPV(financials, rates);
  const rim              = calculateRIM(financials, rates);
  const ncav             = calculateNCAV(financials);
  const peerMultiples    = calculatePeerMultiples(financials, sectorMedians);
  const interestCoverage = calculateInterestCoverage(financials);
  const sortino          = calculateSortino(financials, marketRates?.riskFreeRate);
  const beneish          = calculateBeneish(financials);
  const composite        = calculateCompositeFairValue(financials, {
    dcf, graham: grahamNumber, grahamRevised, peterLynch, ddm, epv, rim,
    peerMultiples, beneish,
  });

  return {
    dcf, grahamNumber, ratios, reverseDCF, peterLynch, evMultiples,
    ruleOf40, grahamRevised, piotroski, altmanZ, ddm, epv, rim, ncav,
    peerMultiples, interestCoverage, sortino, beneish, composite,
  };
}
