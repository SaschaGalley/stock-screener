/**
 * How long a dividend has been raised, from the payments Yahoo lists.
 *
 * Every series here is made up, but each is the shape of something found in
 * Yahoo's real history: a special several times the regular payment, a
 * payment listed twice, a spin-off booked as a dividend, a payment slipping
 * across New Year, a cut whose sums spill into the next year, and a dividend
 * converted from another currency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dividendRecord } from '../src/analysis/payout.js';

/** Quarterly payments from `from` through `to`, raised by `step` every year from the second. */
function quarterly(from: number, to: number, start: number, step: number, months = ['02-10', '05-10', '08-10', '11-10']) {
  const out: { day: string; amount: number }[] = [];
  for (let y = from; y <= to; y++) {
    const amount = Number((start * (1 + step) ** (y - from)).toFixed(4));
    for (const md of months) out.push({ day: `${y}-${md}`, amount });
  }
  return out;
}

describe('the dividend record', () => {
  it('counts the years in a row the dividend rose, up to last year', () => {
    const r = dividendRecord(quarterly(2010, 2026, 0.5, 0.05), '2026-10-10')!;
    assert.equal(r.through, 2025);
    assert.equal(r.raisedYears, 15, '2011 through 2025');
    assert.equal(r.paidYears, 16);
    assert.equal(r.fromStart, true);
    assert.equal(r.lastCut, null);
  });

  it('does not break the run for a year not raised yet', () => {
    // This year's payments equal last year's: the raise may still come.
    const payments = [...quarterly(2015, 2025, 1, 0.04), { day: '2026-02-10', amount: Number((1.04 ** 10).toFixed(4)) }];
    assert.equal(dividendRecord(payments, '2026-03-01')!.raisedYears, 10);
  });

  it('stops the run at a year held flat', () => {
    const payments = [...quarterly(2015, 2019, 1, 0.04), ...quarterly(2020, 2025, 1.04 ** 4, 0.04)];
    // 2020 pays what 2019 paid.
    assert.equal(dividendRecord(payments, '2026-10-10')!.raisedYears, 5, '2021 through 2025');
  });

  it('sets aside a special several times the regular payment', () => {
    const payments = [...quarterly(2015, 2025, 1, 0.1), { day: '2020-12-20', amount: 10 }];
    const r = dividendRecord(payments, '2026-10-10')!;
    assert.deepEqual(r.setAside, [{ day: '2020-12-20', amount: 10 }]);
    assert.equal(r.raisedYears, 10, 'neither 2020 raised by it nor 2021 cut');
  });

  it('sets aside a payment listed twice at double the amount', () => {
    const payments = [...quarterly(2000, 2005, 0.09, 0.05), { day: '2002-08-05', amount: 0.18 }];
    const r = dividendRecord(payments, '2006-06-01')!;
    assert.deepEqual(r.setAside, [{ day: '2002-08-05', amount: 0.18 }]);
    assert.equal(r.raisedYears, 5);
    assert.equal(r.lastCut, null);
  });

  it('sets aside a spin-off booked as a dividend, and a stray cent', () => {
    const payments = [
      ...quarterly(2000, 2005, 0.2, 0.05),
      { day: '2002-06-01', amount: 0.36 },   // the spin-off: under 2.5× the regular one
      { day: '2003-06-20', amount: 0.01 },
    ];
    const r = dividendRecord(payments, '2006-06-01')!;
    assert.deepEqual(r.setAside.map((p) => p.day), ['2002-06-01', '2003-06-20']);
    assert.equal(r.raisedYears, 5);
  });

  it('compares average payments when one slips across New Year', () => {
    // 2022's November payment goes out on 2 January 2023: four, three, five, four.
    const payments = quarterly(2020, 2025, 1, 0.05).map((p) => (p.day === '2022-11-10' ? { ...p, day: '2023-01-02' } : p));
    const r = dividendRecord(payments, '2026-10-10')!;
    assert.equal(r.raisedYears, 5);
    assert.deepEqual(r.years.map((y) => y.payments), [4, 4, 3, 5, 4, 4]);
  });

  it('dates a cut by its first lower payment, not again in the year after', () => {
    const payments = [
      ...quarterly(2018, 2022, 0.4, 0.05),
      { day: '2023-02-10', amount: 0.4862 }, { day: '2023-05-10', amount: 0.15 },
      { day: '2023-08-10', amount: 0.15 },   { day: '2023-11-10', amount: 0.15 },
      ...quarterly(2024, 2025, 0.15, 0),
    ];
    const r = dividendRecord(payments, '2026-10-10')!;
    assert.equal(r.lastCut?.day, '2023-05-10');
    assert.equal(r.lastCut?.to, 0.15);
    assert.equal(r.raisedYears, 0);
    assert.equal(r.paidYears, 8);
  });

  it('counts a cut this year against the run', () => {
    const payments = [...quarterly(2015, 2025, 1, 0.05), { day: '2026-02-10', amount: 0.5 }];
    const r = dividendRecord(payments, '2026-10-10')!;
    assert.equal(r.raisedYears, 0);
    assert.equal(r.lastCut?.day, '2026-02-10');
  });

  it('reads an interim and a final against their own counterparts', () => {
    // Semi-annual: a small interim, a final twice its size. Neither is a cut.
    const payments: { day: string; amount: number }[] = [];
    for (let y = 2015; y <= 2025; y++) {
      const g = 1.06 ** (y - 2015);
      payments.push({ day: `${y}-05-20`, amount: Number((2 * g).toFixed(4)) }, { day: `${y}-09-20`, amount: Number(g.toFixed(4)) });
    }
    const r = dividendRecord(payments, '2026-10-10')!;
    assert.equal(r.lastCut, null);
    assert.deepEqual(r.setAside, []);
    assert.equal(r.raisedYears, 10);
  });

  it('counts only the years paid where the dividend is converted from another currency', () => {
    const r = dividendRecord(quarterly(2015, 2025, 1, 0.05), '2026-10-10', 'EUR')!;
    assert.equal(r.raisedYears, null);
    assert.equal(r.lastCut, null);
    assert.equal(r.paidYears, 11);
    assert.equal(r.convertedFrom, 'EUR');
  });

  it('hedges the runs only where the record starts with the price history', () => {
    const payments = quarterly(2003, 2025, 0.1, 0.1);
    assert.equal(dividendRecord(payments, '2026-10-10', null, '2000-01-01')!.fromStart, true, 'may have paid before 2000');
    assert.equal(dividendRecord(payments, '2026-10-10', null, '1986-03-01')!.fromStart, false, 'began paying in 2003');
  });

  it('has no record for a company that never paid', () => {
    assert.equal(dividendRecord([], '2026-10-10'), null);
  });
});
