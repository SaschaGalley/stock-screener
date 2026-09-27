/**
 * The figures every valuation model reads, on one basis.
 *
 * The models used to reach into the payload each on their own terms, and a
 * payload field does not always mean the same thing: `freeCashFlow` was Yahoo's
 * levered FCF until FINANCIALS_VERSION 21 and is operating cash flow less capex
 * since, `sharesOutstanding` counted one share class, `ebit` was the EBIT line
 * with investment gains in it. The history the score series is recomputed from
 * holds payloads of both kinds, so the question "what is this company's free
 * cash flow" has to be answered once, here, for both.
 *
 * Payloads that carry `trailingSource` were built from the quarterly
 * statements and are read as they are. For the ones before, everything that can
 * be rebuilt from what they do carry is rebuilt — the statement series, the
 * quarterly revenues, market cap over price — and nothing is read that means
 * something else.
 */

import { StockFinancials } from '../types.js';
import { toFiniteNumber } from '../utils/num.js';
import { annualGrowth, latestValue, trailingGrowth, YearPoint } from './trailing.js';

/** Effective tax rate when a payload carries none. */
export const DEFAULT_TAX_RATE = 0.21;

/** Marginal tax rate when the country table had no answer: roughly the OECD average. */
export const DEFAULT_MARGINAL_TAX_RATE = 0.25;

export interface ValuationBasis {
  price: number;
  /** Shares the price is quoted per — every class, ADR units for an ADR. */
  shares: number | null;
  /** `shares` with options, RSUs and convertibles: what the equity is divided between. */
  dilutedShares: number | null;
  /** Trailing twelve months. */
  revenue: number | null;
  revenueGrowth: number | null;
  /** Trailing operating income. */
  operatingIncome: number | null;
  /** Operating margin per fiscal year, oldest first. */
  operatingMargins: number[];
  /** Net income excluding unusual items where the payload has it, else as reported. */
  earnings: number | null;
  earningsHistory: YearPoint[];
  earningsGrowth: number | null;
  /** `earnings` per diluted share. */
  eps: number | null;
  /** Operating cash flow less capex. */
  freeCashFlow: number | null;
  freeCashFlowHistory: YearPoint[];
  operatingIncomeHistory: YearPoint[];
  revenueHistory: YearPoint[];
  taxRate: number;
  marginalTaxRate: number;
  /** Debt the operating cash flows are before: total debt less US-GAAP operating leases. */
  debt: number;
  cash: number;
  nonOperatingAssets: number;
  minorityInterest: number;
  preferredEquity: number;
  /** Common equity on the newest balance sheet. */
  equity: number | null;
  bookValuePerShare: number | null;
}

const num = toFiniteNumber;

/** Per-year ratio of two annual series, matched by year. */
function ratioByYear(top: YearPoint[] | undefined, bottom: YearPoint[] | undefined): number[] {
  const denom = new Map((bottom ?? []).map((p) => [p.year, p.value]));
  const out: number[] = [];
  for (const p of top ?? []) {
    const d = denom.get(p.year);
    if (d !== undefined && d > 0 && Number.isFinite(p.value)) out.push(p.value / d);
  }
  return out;
}

/**
 * The part of total debt the cash flows are already net of. Under US GAAP an
 * operating lease's rent sits in operating income and operating cash flow, so
 * its liability is not debt a free-cash-flow model may subtract again; Yahoo's
 * total debt carries it all the same. Bounded by the leases Yahoo actually put
 * into the total, so nothing is taken out that was never in.
 */
function operatingLeasesInDebt(f: StockFinancials): number {
  const sec = num(f.operatingLeaseLiabilities);
  const inDebt = num(f.leaseObligations);
  if (sec === null || sec <= 0 || inDebt === null || inDebt <= 0) return 0;
  return Math.min(sec, inDebt);
}

export function valuationBasis(f: StockFinancials): ValuationBasis {
  const modern = f.trailingSource !== undefined;
  const history = f.fundamentalsHistory ?? ({} as StockFinancials['fundamentalsHistory']);
  const price = num(f.price) ?? 0;
  const marketCap = num(f.marketCap);

  // Market cap over price is the count every payload can answer, whatever
  // Yahoo's share field meant when it was stored.
  const shares = marketCap !== null && marketCap > 0 && price > 0
    ? marketCap / price
    : num(f.sharesOutstanding);
  const dilution = Math.max(1, num(f.dilutedShareRatio) ?? 1);
  const dilutedShares = shares !== null ? shares * dilution : null;

  const revenue = num(f.revenue);
  // The quarterly revenues ride in every payload since FINANCIALS_VERSION 14,
  // so the four-quarter growth rate is rebuilt for the old ones too.
  const quarterlyRevenues = (Array.isArray(f.quarterlyRevenues) ? f.quarterlyRevenues : [])
    .map((q) => ({ endDate: q.endDate, value: q.revenue }));
  const revenueGrowth = modern
    ? num(f.revenueGrowth)
    : trailingGrowth(quarterlyRevenues) ?? annualGrowth(history.revenue);

  const operatingIncome = modern
    ? num(f.ebit)
    : latestValue(history.operatingIncome) ?? num(f.ebit);

  const earningsHistory = history.normalizedIncome && history.normalizedIncome.length > 0
    ? history.normalizedIncome
    : history.netIncome ?? [];
  const earnings = num(f.normalizedNetIncome) ?? num(f.netIncome);

  const freeCashFlow = modern
    ? num(f.freeCashFlow)
    : latestValue(history.freeCashFlow);

  const equity = modern
    ? (num(f.bookValue) !== null && shares !== null ? (f.bookValue as number) * shares : latestValue(history.stockholdersEquity))
    : latestValue(history.stockholdersEquity);

  return {
    price,
    shares,
    dilutedShares,
    revenue,
    revenueGrowth,
    operatingIncome,
    operatingMargins: ratioByYear(history.operatingIncome, history.revenue),
    earnings,
    earningsHistory,
    earningsGrowth: modern ? num(f.earningsGrowth) : annualGrowth(history.netIncome),
    eps: earnings !== null && dilutedShares !== null && dilutedShares > 0 ? earnings / dilutedShares : null,
    freeCashFlow,
    freeCashFlowHistory: history.freeCashFlow ?? [],
    operatingIncomeHistory: history.operatingIncome ?? [],
    revenueHistory: history.revenue ?? [],
    taxRate: num(f.taxRate) ?? DEFAULT_TAX_RATE,
    marginalTaxRate: num(f.marginalTaxRate) ?? DEFAULT_MARGINAL_TAX_RATE,
    debt: Math.max(0, (num(f.totalDebt) ?? 0) - operatingLeasesInDebt(f)),
    cash: num(f.totalCash) ?? 0,
    nonOperatingAssets: num(f.nonOperatingAssets) ?? 0,
    minorityInterest: num(f.minorityInterest) ?? 0,
    preferredEquity: num(f.preferredEquity) ?? 0,
    equity,
    bookValuePerShare: equity !== null && shares !== null && shares > 0 ? equity / shares : null,
  };
}

/**
 * From firm value to value per share: less the debt the cash flows are before,
 * plus cash and the investments the operating income does not earn on, less the
 * claims ranking ahead of the common shareholders, over every share including
 * dilution.
 */
export function equityPerShare(enterpriseValue: number, b: ValuationBasis): number | null {
  if (b.dilutedShares === null || b.dilutedShares <= 0) return null;
  const equity = enterpriseValue - b.debt + b.cash + b.nonOperatingAssets - b.minorityInterest - b.preferredEquity;
  return equity / b.dilutedShares;
}

/** Net debt as the equity bridge counts it. */
export function bridgeNetDebt(b: ValuationBasis): number {
  return b.debt - b.cash - b.nonOperatingAssets + b.minorityInterest + b.preferredEquity;
}
