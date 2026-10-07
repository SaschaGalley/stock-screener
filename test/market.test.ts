/**
 * The market lists: a Yahoo quote read as a row, and the day's movers.
 * Every ticker and figure here is invented.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MARKET_LISTS, movers, quoteRow, volumeRatio, type MarketRow } from '../src/analysis/market.js';

describe('a quote as a row', () => {
  it('reads percentages as fractions, the epoch as a date, and the long name first', () => {
    const row = quoteRow({
      symbol: 'beisp', shortName: 'Beispiel', longName: 'Beispiel Holdings AG', fullExchangeName: 'NasdaqGS', currency: 'USD',
      regularMarketPrice: 42.5, regularMarketChangePercent: 12.5, fiftyTwoWeekChangePercent: -30,
      regularMarketVolume: 3_000_000, averageDailyVolume3Month: 1_000_000, marketCap: 4e9, trailingPE: 18.2,
      regularMarketTime: 1_790_000_000,
    });
    assert.deepEqual(row, {
      symbol: 'BEISP', name: 'Beispiel Holdings AG', exchange: 'NasdaqGS', currency: 'USD', price: 42.5,
      change: 0.125, year: -0.3, volume: 3_000_000, avgVolume: 1_000_000, marketCap: 4e9, pe: 18.2,
      time: new Date(1_790_000_000 * 1000).toISOString(),
    });
  });

  it('leaves out a quote without a ticker and takes missing figures as unknown', () => {
    assert.equal(quoteRow({ shortName: 'Ohne' }), null);
    const row = quoteRow({ symbol: 'LEER', regularMarketChangePercent: 'n/a' });
    assert.equal(row?.change, null);
    assert.equal(row?.name, null);
  });
});

describe('the day\'s movers', () => {
  const row = (symbol: string, change: number | null): MarketRow => ({
    symbol, name: null, exchange: null, currency: 'USD', price: 10, change, year: null, volume: null, avgVolume: null,
    marketCap: null, pe: null, time: null, status: 'reference', score: null, verdict: null, logoDomain: null, sector: null, industry: null,
  });

  it('takes the biggest rises and falls, a flat or unknown day in neither', () => {
    const { up, down } = movers([row('A', 0.02), row('B', 0.05), row('C', -0.01), row('D', -0.04), row('E', 0), row('F', null)], 2);
    assert.deepEqual(up.map((r) => r.symbol), ['B', 'A']);
    assert.deepEqual(down.map((r) => r.symbol), ['D', 'C']);
  });

  it('compares the volume with the usual', () => {
    assert.equal(volumeRatio({ volume: 3e6, avgVolume: 1e6 }), 3);
    assert.equal(volumeRatio({ volume: 3e6, avgVolume: 0 }), null);
    assert.equal(volumeRatio({ volume: null, avgVolume: 1e6 }), null);
  });
});

describe('the lists', () => {
  it('names each list once', () => {
    const keys = MARKET_LISTS.map((l) => l.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});
