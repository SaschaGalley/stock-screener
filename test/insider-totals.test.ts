/**
 * The insider totals count buying with the insider's own money, not every
 * share that reached an insider: grants and option exercises were paid for by
 * nobody at market price.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { insiderTotals, isOpenMarketPurchase, tradeKind } from '../src/analysis/holders.js';
import { insiderTransactionsFrom } from '../src/data/yahoo-raw.js';

/** Yahoo's insiderTransactions module, as the refresh receives it — invented filers and figures. */
const MODULE = {
  transactions: [
    { startDate: new Date('2026-09-02'), filerName: 'DOE JANE',   transactionText: 'Purchase at price 41.20 per share.',                                    shares: 1_000, value: 41_200 },
    { startDate: new Date('2026-08-14'), filerName: 'ROE RICHARD', transactionText: 'Stock Award(Grant) at price 0.00 per share.',                          shares: 5_000, value: 0 },
    { startDate: new Date('2026-08-14'), filerName: 'ROE RICHARD', transactionText: 'Conversion of Exercise of derivative security at price 12.00 per share.', shares: 8_000, value: 96_000 },
    { startDate: new Date('2026-08-15'), filerName: 'ROE RICHARD', transactionText: 'Sale at price 44.10 - 44.80 per share.',                               shares: 3_000, value: 133_500 },
    { startDate: new Date('2026-07-30'), filerName: 'POE PAT',     transactionText: '',                                                                       shares: 2_500, value: null },
    { startDate: new Date('2026-07-01'), filerName: 'POE PAT',     transactionText: 'Stock Gift at price 0.00 per share.',                                    shares: 400,   value: 0 },
    // Before the window: a purchase that no longer counts.
    { startDate: new Date('2026-01-20'), filerName: 'DOE JANE',   transactionText: 'Purchase at price 30.00 per share.',                                    shares: 500,   value: 15_000 },
  ],
};

const SINCE = '2026-04-10';

describe('insider totals', () => {
  it('counts only the open-market purchase as buying, and the sale as selling', () => {
    const t = insiderTotals(insiderTransactionsFrom(MODULE), SINCE);
    assert.deepEqual(t, {
      insiderBuyShares: 1_000, insiderSellShares: 3_000,
      insiderBuyValue: 41_200, insiderSellValue: 133_500,
      insiderBuyCount: 1, insiderSellCount: 1,
    });
  });

  it('reports no buying at all where the insiders were only granted and exercised', () => {
    const rows = insiderTransactionsFrom(MODULE).filter((r) => !r.description?.startsWith('Purchase'));
    const t = insiderTotals(rows, SINCE);
    assert.equal(t.insiderBuyCount, null);
    assert.equal(t.insiderBuyShares, null);
    assert.equal(t.insiderBuyValue, null);
    assert.equal(t.insiderSellCount, 1);
  });

  it('is empty without trades in the window', () => {
    assert.deepEqual(insiderTotals(insiderTransactionsFrom(MODULE), '2026-10-01'), {
      insiderBuyShares: null, insiderSellShares: null, insiderBuyValue: null,
      insiderSellValue: null, insiderBuyCount: null, insiderSellCount: null,
    });
  });

  it('reads the wording the same way for the trade list and the timeline', () => {
    const kinds = MODULE.transactions.map((t) => tradeKind(t.transactionText || null));
    assert.deepEqual(kinds, ['purchase', 'other', 'other', 'sale', 'other', 'other', 'purchase']);
    assert.ok(isOpenMarketPurchase('  PURCHASE AT PRICE 9.99 per share.'));
    assert.ok(!isOpenMarketPurchase('Purchased via employee plan'));
    assert.ok(!isOpenMarketPurchase(null));
  });
});
