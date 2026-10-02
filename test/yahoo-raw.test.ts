/**
 * Yahoo's answers mapped into the archive's rows: nothing invented, nothing
 * that is not a row kept.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analystActionsFrom, insiderTransactionsFrom, priceBarsFrom, priceEventsFrom } from '../src/data/yahoo-raw.js';

describe('the archive rows', () => {
  it('keeps both closes and drops a bar without one', () => {
    const bars = priceBarsFrom([
      { date: new Date('2026-10-01T13:30:00Z'), open: 1, high: 2, low: 0.5, close: 1.5, adjclose: 1.4, volume: 100 },
      { date: new Date('2026-10-02T13:30:00Z'), open: 1, close: null },
    ]);
    assert.deepEqual(bars, [{ day: '2026-10-01', close: 1.5, open: 1, high: 2, low: 0.5, adjClose: 1.4, volume: 100 }]);
  });

  it('reads splits as new shares per old and dividends per share, from arrays or keyed objects', () => {
    const ev = priceEventsFrom({
      splits: { a: { date: new Date('2020-08-31'), numerator: 4, denominator: 1 } },
      dividends: [{ date: new Date('2026-08-11'), amount: 0.26 }, { date: new Date('2026-05-12'), amount: 0 }],
    });
    assert.deepEqual(ev, [
      { day: '2020-08-31', kind: 'split', value: 4 },
      { day: '2026-08-11', kind: 'dividend', value: 0.26 },
    ]);
  });

  it('keeps a rating action with its targets and skips one without a firm', () => {
    const rows = analystActionsFrom({ history: [
      { epochGradeDate: new Date('2026-10-01T15:55:51Z'), firm: 'Morgan Stanley', toGrade: 'Overweight', fromGrade: 'Overweight',
        action: 'main', priceTargetAction: 'Lowers', currentPriceTarget: 355, priorPriceTarget: 360 },
      { epochGradeDate: new Date('2026-09-01T00:00:00Z'), firm: '' },
    ] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].priceTarget, 355);
    assert.equal(rows[0].gradedAt, '2026-10-01T15:55:51.000Z');
  });

  it('maps an insider trade field by field', () => {
    const [t] = insiderTransactionsFrom({ transactions: [{
      shares: 2399, value: 806496, transactionText: 'Sale at price 336.18 per share.', filerName: 'NEWSTEAD JENNIFER',
      filerRelation: 'General Counsel', startDate: new Date('2026-09-29T00:00:00Z'), ownership: 'D',
    }] });
    assert.deepEqual(t, {
      tradedOn: '2026-09-29', filer: 'NEWSTEAD JENNIFER', relation: 'General Counsel',
      description: 'Sale at price 336.18 per share.', shares: 2399, value: 806496, ownership: 'D',
    });
  });
});
