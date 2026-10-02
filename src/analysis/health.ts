/**
 * The balance sheet as a checklist, and how long the cash lasts.
 *
 * The scores elsewhere answer "how healthy, relative to the typical stock".
 * These answer the plain questions a reader asks first, each with the figures
 * behind it: can it pay what falls due this year, could it pay its long-term
 * debts, does it hold more cash than debt, can it carry its interest, is it
 * paying for itself by printing shares — and, for a company that burns cash,
 * how many months before it has to raise more. That last one is the question
 * for half the speculative names on a watchlist, and nothing answered it.
 *
 * Lenders are left out of the liquidity checks: their debt is their inventory
 * and their current assets are loans, so "current assets cover current
 * liabilities" says nothing about a bank.
 */

import type { InterestCoverageResult, StockFinancials } from '../types.js';
import { fmtBig } from '../format.js';
import { toFiniteNumber } from '../utils/num.js';
import { borrowsToLend } from './dcf.js';

export type HealthMark = 'pass' | 'mixed' | 'fail';

export interface HealthCheck {
  key:   string;
  label: string;
  mark:  HealthMark;
  note:  string;
}

export interface HealthResult {
  checks:       HealthCheck[];
  /** Months of cash at the trailing free-cash-flow burn; null when the company is not burning cash. */
  runwayMonths: number | null;
  lender:       boolean;
}

/** Runway long enough that a raise is a choice, not a deadline. */
const RUNWAY_COMFORTABLE_MONTHS = 36;
const RUNWAY_SHORT_MONTHS = 12;

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(1)} %`;

export function calculateHealthChecks(f: StockFinancials, coverage: InterestCoverageResult): HealthResult {
  const lender = borrowsToLend(f);
  const checks: HealthCheck[] = [];
  const big = (v: number) => fmtBig(v, f.tradingCurrency);
  const n = (v: unknown) => toFiniteNumber(v);

  const cash = n(f.totalCash);
  const debt = n(f.totalDebt);
  const ca = n(f.totalCurrentAssets);
  const cl = n(f.totalCurrentLiabilities);
  const tl = n(f.totalLiabilities);

  if (!lender) {
    if (ca !== null && cl !== null && cl > 0) {
      const r = ca / cl;
      checks.push({
        key: 'short-term', label: 'Kurzfristige Verbindlichkeiten gedeckt',
        mark: r >= 1 ? 'pass' : r >= 0.8 ? 'mixed' : 'fail',
        note: `Umlaufvermögen ${big(ca)} gegen ${big(cl)} fällig binnen eines Jahres (${r.toFixed(2)}x)`,
      });
    }
    if (ca !== null && cl !== null && tl !== null && tl - cl > 0) {
      const lt = tl - cl;
      const r = ca / lt;
      checks.push({
        key: 'long-term', label: 'Langfristige Verbindlichkeiten gedeckt',
        mark: r >= 1 ? 'pass' : r >= 0.5 ? 'mixed' : 'fail',
        note: `Umlaufvermögen ${big(ca)} gegen ${big(lt)} langfristige Verbindlichkeiten (${r.toFixed(2)}x)`,
      });
    }
    if (cash !== null && debt !== null) {
      const ebitda = n(f.ebitda);
      const netDebt = debt - cash;
      const lev = ebitda !== null && ebitda > 0 ? netDebt / ebitda : null;
      checks.push({
        key: 'net-cash', label: 'Mehr Cash als Schulden',
        mark: netDebt <= 0 ? 'pass' : lev !== null && lev <= 2 ? 'mixed' : 'fail',
        note: netDebt <= 0
          ? `Cash ${big(cash)} übersteigt die Schulden von ${big(debt)}`
          : `Nettoverschuldung ${big(netDebt)}${lev !== null ? `, ${lev.toFixed(1)}x EBITDA` : ', ohne positives EBITDA'}`,
      });
    }
  }

  if (coverage.interpretation !== 'unknown') {
    const i = coverage.interpretation;
    checks.push({
      key: 'interest', label: 'Zinsen gedeckt',
      mark: i === 'excellent' || i === 'good' ? 'pass' : i === 'fair' ? 'mixed' : 'fail',
      note: coverage.ratio !== null && coverage.ratio > 0
        ? `Operatives Ergebnis deckt die Zinsen ${coverage.ratio.toFixed(1)}-fach`
        : coverage.ratio !== null
          ? 'Operativer Verlust — die Zinsen werden aus der Substanz bezahlt'
          : i === 'excellent' ? 'Keine Schulden, die Zinsen kosten' : 'Operativer Verlust bei bestehenden Schulden',
    });
  }

  const shares = n(f.sharesOutstandingAnnual);
  const sharesBefore = n(f.prevYear?.sharesOutstanding);
  if (shares !== null && sharesBefore !== null && sharesBefore > 0) {
    const d = shares / sharesBefore - 1;
    checks.push({
      key: 'dilution', label: 'Keine nennenswerte Verwässerung',
      mark: d <= 0.02 ? 'pass' : d <= 0.05 ? 'mixed' : 'fail',
      note: `Aktienzahl ${pct(d)} gegenüber dem Vorjahr`,
    });
  }

  // Runway: only a question for a company that loses money or burns cash.
  const fcf = n(f.freeCashFlow);
  const ni = n(f.netIncome);
  let runwayMonths: number | null = null;
  if (!lender && fcf !== null && fcf < 0 && cash !== null) {
    runwayMonths = cash / (-fcf / 12);
    checks.push({
      key: 'runway', label: 'Cash reicht drei Jahre',
      mark: runwayMonths >= RUNWAY_COMFORTABLE_MONTHS ? 'pass' : runwayMonths >= RUNWAY_SHORT_MONTHS ? 'mixed' : 'fail',
      note: `${big(cash)} Cash bei ${big(-fcf)} Free-Cash-Flow-Abfluss im Jahr: ${runwayMonths >= 120 ? 'über zehn Jahre' : `${Math.round(runwayMonths)} Monate`}`,
    });
  } else if (!lender && fcf !== null && fcf >= 0 && ni !== null && ni < 0) {
    checks.push({
      key: 'runway', label: 'Finanziert sich selbst',
      mark: 'pass',
      note: `Bilanzieller Verlust, aber ${big(fcf)} positiver Free Cash Flow — kein Kapitalbedarf aus dem laufenden Geschäft`,
    });
  }

  return { checks, runwayMonths, lender };
}
