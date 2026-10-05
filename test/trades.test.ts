/**
 * A trade as umsatz sends it. Made-up examples only: the real ones are the
 * owner's holdings and never belong in a test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tradeFromUmsatz } from '../src/trades-service.js';

const sent = {
  id: '00000000-0000-0000-0000-000000000001', day: '2026-03-12', isin: 'xx0000000001', symbol: 'exa',
  name: 'Example Corp', assetType: 'stock', kind: 'buy', quantity: 10, price: '12.5', currency: 'EUR', fee: -1,
};

describe('a trade from umsatz', () => {
  it('is read with its numbers, the ISIN and symbol in upper case', () => {
    assert.deepEqual(tradeFromUmsatz(sent), {
      externalId: sent.id, day: '2026-03-12', isin: 'XX0000000001', sourceSymbol: 'EXA', name: 'Example Corp',
      assetType: 'stock', kind: 'buy', quantity: 10, price: 12.5, currency: 'EUR', fee: -1,
    });
  });

  it('keeps savings plans and spin-offs, with their kind', () => {
    assert.equal(tradeFromUmsatz({ ...sent, kind: 'savings-plan' })?.kind, 'savings-plan');
    assert.equal(tradeFromUmsatz({ ...sent, kind: 'spin-off', symbol: null })?.sourceSymbol, null);
  });

  it('is dropped without an id, a day, an ISIN, a number or a known kind', () => {
    for (const broken of [
      { ...sent, id: '' }, { ...sent, day: '12.3.2026' }, { ...sent, isin: null },
      { ...sent, quantity: 'ten' }, { ...sent, kind: 'transfer' }, null, 'x',
    ]) assert.equal(tradeFromUmsatz(broken), null);
  });
});
