/**
 * One day's cross-section, calibrated as the backtest calibrates every
 * month-end: the peer groups from that day's GICS sub-industries, the model
 * premium of each group from that day's stocks, and every criterion's reference distribution
 * from that day's figures — nothing from any other day.
 *
 * The month-end run (`run.ts`) and the comparison with the live scores
 * (`fidelity.ts`) both score through it, so the comparison measures the
 * backtest as it runs.
 */

import {
  collectCalibrated, percentiles, premiumFor, premiumTable, sectorKey, useCalibrationTable, usePremiumAdjustment,
  type CriterionDistribution, type PremiumAdjustments,
} from '../analysis/calibration.js';
import { computeAllMetrics, impliedPremiumShift } from '../analysis/computeMetrics.js';
import { borrowsToLend } from '../analysis/dcf.js';
import { computeFactorScore } from '../analysis/score.js';
import type { MarketRates } from '../data/fred.js';
import type { FactorScore, MarketSignals, SectorMedians, StockFinancials } from '../types.js';
import { crossSectionPeers } from './peers.js';

export interface CrossEntry {
  c:          { symbol: string; sector: string; subIndustry: string };
  financials: StockFinancials;
  signals:    MarketSignals;
}

export interface CrossSection {
  /** The day's model premium adjustment for operating firms, the median of their DCFs' implied shifts. */
  premium: number;
  /** The day's adjustment for every group with enough stocks (`premiumTable`): the firms and the lenders. */
  premiums: PremiumAdjustments;
  peers:   Map<string, SectorMedians | null>;
  metrics: ReturnType<typeof computeAllMetrics>[];
  /** Entry `k` scored under the day's own distributions and premium. */
  score:   (k: number) => FactorScore;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Calibrate the day and leave its table and premium in force
 * (`useCalibrationTable`, `usePremiumAdjustment`): `score` reads them, and so
 * does anything the caller scores before it restores the committed ones.
 */
export function calibrateCrossSection(entries: readonly CrossEntry[], rates: MarketRates): CrossSection {
  const peers = crossSectionPeers(entries.map((e) => ({
    symbol: e.c.symbol, sector: e.c.sector, subIndustry: e.c.subIndustry, financials: e.financials,
  })));

  // The day's premium adjustments, from the day's stocks only, each group's
  // from the model that carries it.
  usePremiumAdjustment(0);
  const points = entries.flatMap((e) => {
    const shift = impliedPremiumShift({ financials: e.financials, rates, sectorMedians: peers.get(e.c.symbol) ?? null });
    return shift === null ? [] : [{ currency: e.financials.tradingCurrency, lender: borrowsToLend(e.financials), shift }];
  });
  const premiums = premiumTable(points).adjustments;
  const premium = premiumFor(premiums, null, false);
  usePremiumAdjustment(premiums);

  const metrics = entries.map((e) => computeAllMetrics(e.financials, rates, peers.get(e.c.symbol) ?? null));
  const score = (k: number) => computeFactorScore({
    financials: entries[k].financials, metrics: metrics[k], sectorMedians: peers.get(entries[k].c.symbol) ?? null,
    marketSignals: entries[k].signals, technicalSignals: null,
  });

  // The day's reference distributions, from the day's cross-section only.
  const values = new Map<string, number[]>();
  const add = (key: string, value: number) => values.set(key, [...(values.get(key) ?? []), value]);
  collectCalibrated((key, value, sector) => {
    add(key, value);
    if (sector) add(sectorKey(key, sector), value);
  }, () => entries.forEach((_, k) => score(k)));
  const table: Record<string, CriterionDistribution> = {};
  for (const [key, xs] of values) table[key] = { quantiles: percentiles(xs), n: xs.length, symbols: xs.length };
  useCalibrationTable(table);
  usePremiumAdjustment(premiums);

  return { premium, premiums, peers, metrics, score };
}
