/**
 * The balance sheet as a checklist: the plain questions, and how long the cash
 * lasts for a company that burns it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calculateHealthChecks } from '../src/analysis/health.js';
import type { InterestCoverageResult, StockFinancials } from '../src/types.js';

const company = (over: Partial<Record<keyof StockFinancials, unknown>> = {}): StockFinancials => ({
  symbol: 'TEST', tradingCurrency: 'USD', sector: 'Technology', industry: 'Software - Application',
  revenue: 1_000, totalCash: 300, totalDebt: 100, ebitda: 200, netIncome: 50, freeCashFlow: 80,
  totalCurrentAssets: 600, totalCurrentLiabilities: 300, totalLiabilities: 500,
  sharesOutstandingAnnual: 100, prevYear: { sharesOutstanding: 100 },
  interestExpense: 5,
  ...over,
} as unknown as StockFinancials);

const cover = (interpretation: InterestCoverageResult['interpretation'], ratio: number | null = null): InterestCoverageResult =>
  ({ interpretation, ratio } as InterestCoverageResult);

const mark = (r: ReturnType<typeof calculateHealthChecks>, key: string) => r.checks.find((c) => c.key === key)?.mark;

describe('the balance-sheet checklist', () => {
  it('passes a company with net cash, covered liabilities and no dilution', () => {
    const r = calculateHealthChecks(company(), cover('excellent', 40));
    assert.deepEqual(r.checks.map((c) => c.mark), ['pass', 'pass', 'pass', 'pass', 'pass']);
    assert.equal(r.runwayMonths, null, 'no runway question for a company that earns its cash');
  });

  it('reads net debt against EBITDA rather than failing all debt', () => {
    assert.equal(mark(calculateHealthChecks(company({ totalCash: 50, totalDebt: 350 }), cover('good', 6)), 'net-cash'), 'mixed');
    assert.equal(mark(calculateHealthChecks(company({ totalCash: 50, totalDebt: 1_050 }), cover('good', 6)), 'net-cash'), 'fail');
  });

  it('flags dilution above five per cent', () => {
    const r = calculateHealthChecks(company({ sharesOutstandingAnnual: 112 }), cover('excellent'));
    assert.equal(mark(r, 'dilution'), 'fail');
  });

  it('counts the months a cash burner has left', () => {
    // 300 in cash against a burn of 200 a year: 18 months.
    const r = calculateHealthChecks(company({ freeCashFlow: -200, netIncome: -250 }), cover('critical'));
    assert.equal(Math.round(r.runwayMonths!), 18);
    assert.equal(mark(r, 'runway'), 'mixed');
  });

  it('calls a loss-maker with positive free cash flow self-funding', () => {
    const r = calculateHealthChecks(company({ netIncome: -20, freeCashFlow: 30 }), cover('critical'));
    assert.equal(mark(r, 'runway'), 'pass');
    assert.equal(r.runwayMonths, null);
  });

  it('leaves a bank out of the liquidity checks', () => {
    const r = calculateHealthChecks(company({ industry: 'Banks - Regional', sector: 'Financial Services' }), cover('unknown'));
    assert.equal(r.lender, true);
    assert.ok(!r.checks.some((c) => ['short-term', 'long-term', 'net-cash', 'runway'].includes(c.key)));
  });
});
