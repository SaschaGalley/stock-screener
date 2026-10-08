/** A made-up depot looked through its made-up funds. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { companyKey, lookThrough, OTHER, type FundHoldings } from '../src/analysis/look-through.js';
import { parseTopHoldings } from '../src/data/fund-holdings.js';

const fund: FundHoldings = {
  symbol: 'WRLD', asOf: '2026-10-08', equity: 0.98, bonds: null, cash: 0.02,
  holdings: [
    { symbol: 'MADE', name: 'Made Up Corp', weight: 0.05 },
    { symbol: 'ALPC', name: 'Alpha Beta Inc Class C', weight: 0.02 },
    { symbol: 'OTHR', name: 'Other Holdings PLC', weight: 0.01 },
  ],
  sectors: [{ sector: 'Technology', weight: 0.4 }, { sector: 'Financial Services', weight: 0.6 }],
};

const positions = [
  { symbol: 'WRLD', name: 'Made Up World ETF', assetType: 'etf', sector: null, weight: 0.5 },
  { symbol: 'NOPE', name: 'Undescribed ETF', assetType: 'etf', sector: null, weight: 0.1 },
  { symbol: 'MADE', name: 'Made Up Corporation', assetType: 'stock', sector: 'Technology', weight: 0.2 },
  { symbol: 'ALPA', name: 'Alpha Beta Inc.', assetType: 'stock', sector: 'Communication Services', weight: 0.1 },
  { symbol: 'COIN-USD', name: 'Some Coin', assetType: 'crypto', sector: null, weight: 0.1 },
];

describe('the look-through', () => {
  const lt = lookThrough(positions, new Map([['WRLD', fund]]));
  const sector = (s: string) => lt.sectors.find((x) => x.sector === s)!;

  it('reads a fund as its sectors, scaled by its equity part and its weight', () => {
    assert.ok(Math.abs(sector('Technology').viaFunds - 0.5 * 0.98 * 0.4) < 1e-9);
    assert.ok(Math.abs(sector('Technology').direct - 0.2) < 1e-9);
    assert.ok(Math.abs(sector(OTHER.cash).total - 0.01) < 1e-9);
    assert.ok(Math.abs(sector(OTHER.unknown).total - 0.1) < 1e-9);
    assert.ok(Math.abs(sector(OTHER.crypto).total - 0.1) < 1e-9);
    assert.deepEqual(lt.unknown, ['NOPE']);
    assert.ok(Math.abs(lt.funds.weight - 0.6) < 1e-9 && Math.abs(lt.funds.known - 0.5) < 1e-9);
  });

  it('adds what the funds hold of a stock held, by ticker or by name across share classes', () => {
    assert.ok(Math.abs(lt.heldViaFunds.MADE - 0.025) < 1e-9);
    assert.ok(Math.abs(lt.heldViaFunds.ALPA - 0.01) < 1e-9);
    const made = lt.stocks.find((x) => x.symbol === 'MADE')!;
    assert.equal(made.name, 'Made Up Corporation');
    assert.ok(made.held && Math.abs(made.total - 0.225) < 1e-9);
    assert.ok(!lt.stocks.find((x) => x.symbol === 'OTHR')!.held);
  });

  it('names a company without its legal form or share class', () => {
    assert.equal(companyKey('Alpha Beta Inc Class C'), companyKey('Alpha Beta Inc.'));
    assert.equal(companyKey('Made Up Corp'), 'made up');
  });
});

describe("Yahoo's fund holdings", () => {
  it('maps its sector keys to the stocks\' sector names and keeps the shares', () => {
    const f = parseTopHoldings('WRLD', {
      stockPosition: { raw: 0.99 }, cashPosition: 0.01,
      holdings: [{ symbol: 'MADE', holdingName: 'Made Up Corp', holdingPercent: { raw: 0.05 } }, { holdingName: '', holdingPercent: 0.1 }],
      sectorWeightings: [{ realestate: 0.1 }, { consumer_cyclical: 0.2 }, { not_a_sector: 0.3 }, { technology: 0.4 }],
    }, '2026-10-08');
    assert.ok(f);
    assert.deepEqual(f.sectors.map((s) => s.sector), ['Real Estate', 'Consumer Cyclical', 'Technology']);
    assert.deepEqual(f.holdings, [{ symbol: 'MADE', name: 'Made Up Corp', weight: 0.05 }]);
    assert.equal(f.equity, 0.99);
    assert.equal(parseTopHoldings('X', { holdings: [], sectorWeightings: [] }), null);
  });
});
