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
 *
 * Each question is asked of the newest figures there are. The current assets
 * and liabilities come from the annual balance sheet, which by the next
 * fiscal year's end is a year old, while cash and debt are the latest
 * quarter's; Apple read 0,89x on the annual sheet and 1,00x in the quarter.
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

/**
 * Share of current liabilities that must be prepaid revenue before the current
 * ratio is read without it.
 *
 * A subscription business collects a year in advance and books it as a current
 * liability it will settle by delivering software, not by paying cash. At
 * ServiceNow that is 80 % of current liabilities: a reported ratio of 0.70 is
 * 3.4 once the prepayments are set aside, and scoring the 0.70 gave one of the
 * most liquid balance sheets on the list 0/10. Below a quarter the adjustment
 * is noise, so an ordinary company's ratio is read as reported.
 */
export const DEFERRED_REVENUE_MIN_SHARE = 0.25;

/** Beyond this the denominator is too small to divide by with any meaning. */
const DEFERRED_REVENUE_MAX_SHARE = 0.9;

/**
 * The current ratio with prepaid revenue taken out of the liabilities.
 *
 * The share comes from the annual balance sheet and the ratio from the latest
 * quarter; the share moves slowly, so scaling the fresh ratio by it is closer
 * to the truth than either the stale annual ratio or the unadjusted fresh one.
 */
export function adjustedCurrentRatio(f: StockFinancials): { ratio: number | null; deferredShare: number | null } {
  const ratio = toFiniteNumber(f.currentRatio);
  const share = toFiniteNumber(f.deferredRevenueShare);
  if (ratio === null || share === null || share < DEFERRED_REVENUE_MIN_SHARE) return { ratio, deferredShare: null };
  const s = Math.min(share, DEFERRED_REVENUE_MAX_SHARE);
  return { ratio: ratio / (1 - s), deferredShare: share };
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
    // The latest quarter's ratio where Yahoo has it, read as the score reads
    // it — prepaid subscriptions set aside; the annual sheet's amounts otherwise.
    const annual = ca !== null && cl !== null && cl > 0 ? ca / cl : null;
    const quarter = adjustedCurrentRatio(f);
    const r = quarter.ratio ?? annual;
    if (r !== null) {
      const atYearEnd = annual !== null && ca !== null && cl !== null
        ? `${big(ca)} gegen ${big(cl)}, ${annual.toFixed(2)}x` : null;
      const prepaid = quarter.deferredShare !== null
        ? `, ohne vorausbezahlte Umsätze (${Math.round(quarter.deferredShare * 100)} % der kurzfristigen Verbindlichkeiten), die mit Leistung statt Geld beglichen werden`
        : '';
      checks.push({
        key: 'short-term', label: 'Kurzfristige Verbindlichkeiten gedeckt',
        mark: r >= 1 ? 'pass' : r >= 0.8 ? 'mixed' : 'fail',
        note: quarter.ratio === null
          ? `Umlaufvermögen ${big(ca!)} gegen ${big(cl!)} fällig binnen eines Jahres (${r.toFixed(2)}x)`
          : `Umlaufvermögen deckt die binnen eines Jahres fälligen Verbindlichkeiten ${r.toFixed(2)}-fach im letzten Quartal${prepaid}`
            + (atYearEnd && !prepaid && Math.abs(annual! - quarter.ratio) >= 0.05 ? ` (zum Geschäftsjahresende ${atYearEnd})` : ''),
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
      // Long-term securities and stakes count as the DCF counts them when it
      // bridges to equity: Apple keeps most of its money in bonds of more than
      // a year, and without them read as indebted with 62 bn net cash.
      const invested = Math.max(0, n(f.nonOperatingAssets) ?? 0);
      const netDebt = debt - cash - invested;
      const lev = ebitda !== null && ebitda > 0 ? netDebt / ebitda : null;
      const held = invested > 0 ? `Cash ${big(cash)} und Finanzanlagen ${big(invested)}` : `Cash ${big(cash)}`;
      checks.push({
        key: 'net-cash', label: invested > 0 ? 'Mehr Cash und Anlagen als Schulden' : 'Mehr Cash als Schulden',
        mark: netDebt <= 0 ? 'pass' : lev !== null && lev <= 2 ? 'mixed' : 'fail',
        note: netDebt <= 0
          ? `${held} ${invested > 0 ? 'übersteigen' : 'übersteigt'} die Schulden von ${big(debt)}`
          : `Nettoverschuldung ${big(netDebt)}${invested > 0 ? ' nach Abzug der Finanzanlagen' : ''}${lev !== null ? `, ${lev.toFixed(1)}x EBITDA` : ', ohne positives EBITDA'}`,
      });
    }
  }

  const ocf = n(f.operatingCashFlow);
  // Only for a company whose operations bring cash in: a cash burner's question
  // is how long the cash lasts, and the runway check below asks it.
  if (coverage.interpretation === 'unknown' && !lender && debt !== null && debt > 0 && ocf !== null && ocf > 0) {
    // Some companies no longer show interest on its own line — Apple has
    // folded it into other income since fiscal 2024 — and then the coverage
    // cannot be read. The question is asked of the cash flow instead: how much
    // of the debt one year of operating cash flow would repay.
    const r = ocf / debt;
    checks.push({
      key: 'debt-cover', label: 'Schulden aus dem Cashflow tragbar',
      mark: r >= 0.2 ? 'pass' : r >= 0.1 ? 'mixed' : 'fail',
      note: `Kein Zinsaufwand ausgewiesen; ein Jahr operativer Cashflow (${big(ocf)}) entspricht ${Math.round(r * 100)} % der Schulden von ${big(debt)}`,
    });
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
