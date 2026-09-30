/**
 * Which TradingView listing a Yahoo ticker's logo comes from.
 *
 * ALV is Allianz in Frankfurt and Autoliv in New York; VIG is Vienna Insurance
 * in Vienna and a Vanguard ETF in Buenos Aires. The suffix decides.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickLogoId, tradingViewQuery } from '../src/data/tradingview-logo.js';

describe('tradingViewQuery', () => {
  it('spells Yahoo tickers the way TradingView does', () => {
    assert.deepEqual(tradingViewQuery('BRK-B'),     { text: 'BRK.B',  country: 'US' });
    assert.deepEqual(tradingViewQuery('ALV.DE'),    { text: 'ALV',    country: 'DE' });
    assert.deepEqual(tradingViewQuery('005930.KS'), { text: '005930', country: 'KR' });
    assert.deepEqual(tradingViewQuery('0700.HK'),   { text: '700',    country: 'HK' });
  });
});

describe('pickLogoId', () => {
  const alv = [
    { symbol: 'ALV', country: 'DE', logoid: 'allianz', is_primary_listing: true },
    { symbol: 'ALV', country: 'US', logoid: 'autoliv', is_primary_listing: true },
  ];

  it('takes the listing in the ticker’s home country', () => {
    assert.equal(pickLogoId(alv, 'ALV', 'DE'), 'allianz');
    assert.equal(pickLogoId(alv, 'ALV', 'US'), 'autoliv');
  });

  it('prefers the primary listing over a secondary one', () => {
    const hits = [
      { symbol: 'VIG', country: 'CZ', logoid: 'vienna-insurance-group-a' },
      { symbol: 'VIG', country: 'AT', logoid: 'vienna-insurance-group-b' },
      { symbol: 'VIG', country: 'AT', logoid: 'vienna-insurance-group-a', is_primary_listing: true },
    ];
    assert.equal(pickLogoId(hits, 'VIG', 'AT'), 'vienna-insurance-group-a');
  });

  it('draws no logo rather than a near-miss’s', () => {
    assert.equal(pickLogoId([{ symbol: 'BRKHM', country: 'US', logoid: 'brk-international-ltd' }], 'BRK.B', 'US'), null);
  });
});
