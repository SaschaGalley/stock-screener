/**
 * What the comparison with the live scores found wrong in the rebuilt
 * payload, kept from coming back: a tag the company stopped using read years
 * later, debt that was not tagged counted as none, a total the filings give
 * only in halves — and the session a live snapshot belongs to.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CompanyFacts, Fact } from '../src/data/edgar-facts.js';
import { payloadAt, type Company } from '../src/backtest/payload.js';
import { sessionOf, type PriceHistory } from '../src/backtest/prices.js';

const d = (start: string | null, end: string, val: number, filed: string): Fact => ({ start, end, val, filed });

/** Every weekday from 2023 to the end of September 2025, at a flat 10. */
function flat(): PriceHistory {
  const dates: string[] = [];
  for (let t = Date.parse('2023-01-02T00:00:00Z'); t <= Date.parse('2025-09-30T00:00:00Z'); t += 86_400_000) {
    const day = new Date(t);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) dates.push(day.toISOString().slice(0, 10));
  }
  return { dates, close: dates.map(() => 10), adj: dates.map(() => 10), splits: [] };
}

const company: Company = {
  symbol: 'XYZ', name: 'XYZ Corp', cik: '1', sector: 'Utilities', subIndustry: 'Electric Utilities', added: null,
};

/** A year to 2024 and a half-year to June 2025, each line as `[FY 2024, H1 2024, H1 2025]`. */
function flows(fy: number, h1Before: number, h1: number): Fact[] {
  return [
    d('2024-01-01', '2024-12-31', fy, '2025-02-20'),
    d('2024-01-01', '2024-06-30', h1Before, '2024-07-30'),
    d('2025-01-01', '2025-06-30', h1, '2025-07-30'),
  ];
}

function facts(lines: Record<string, Fact[]>): CompanyFacts {
  return {
    cik: '1', name: 'XYZ Corp',
    lines: {
      revenue: flows(1000, 480, 520),
      netIncome: flows(80, 40, 44),
      pretaxIncome: flows(100, 50, 55),
      interestExpense: flows(40, 20, 20),
      sharesOutstanding: [d(null, '2025-07-15', 100, '2025-07-30')],
      assets: [d(null, '2024-12-31', 3000, '2025-02-20'), d(null, '2025-06-30', 3100, '2025-07-30')],
      ...lines,
    },
  };
}

const at = (f: CompanyFacts) => payloadAt(company, f, flat(), flat(), null, '2025-09-15')!.financials;

describe('the payload, rebuilt where the filings are thin', () => {
  it('does not read an operating income last tagged years ago, and adds the interest back to the pre-tax income', () => {
    // Twelve months: 1000 + 520 − 480 = 1040 revenue; pre-tax 105, interest 40.
    const f = at(facts({ operatingIncome: [d('2019-01-01', '2019-12-31', 30, '2020-02-20')] }));
    assert.equal(f.revenue, 1040);
    assert.equal(f.ebit, 105 + 40);
    assert.ok(Math.abs((f.operatingMargin ?? 0) - 145 / 1040) < 1e-12);
  });

  it('reads a current operating income as it is', () => {
    const f = at(facts({ operatingIncome: flows(120, 60, 62) }));
    assert.equal(f.ebit, 122);
  });

  it('calls debt unknown, not none, when interest is paid and no debt is tagged', () => {
    const f = at(facts({}));
    assert.equal(f.totalDebt, null);
    assert.equal(f.debtToEquity, null);
    assert.equal(f.enterpriseValue, null);
  });

  it('calls debt none when there is neither a debt tag nor interest', () => {
    const f = at(facts({ interestExpense: [] }));
    assert.equal(f.totalDebt, 0);
    assert.equal(f.enterpriseValue, 1000);
  });

  it('adds the two halves of the liabilities where the total is not tagged', () => {
    const f = at(facts({
      currentLiabilities: [d(null, '2024-12-31', 300, '2025-02-20')],
      liabilitiesNoncurrent: [d(null, '2024-12-31', 1200, '2025-02-20')],
    }));
    assert.equal(f.totalLiabilities, 1500);
  });
});

describe('the session a live snapshot carries', () => {
  const dates = ['2026-09-24', '2026-09-25', '2026-09-28'];

  it('is the day\'s own after the New York close', () => {
    assert.equal(sessionOf(new Date('2026-09-28T21:00:00Z'), dates), '2026-09-28');
  });

  it('is the day before when taken during the session', () => {
    assert.equal(sessionOf(new Date('2026-09-28T14:00:00Z'), dates), '2026-09-25');
  });

  it('is Friday\'s over the weekend', () => {
    assert.equal(sessionOf(new Date('2026-09-27T00:30:00Z'), dates), '2026-09-25');
  });
});
