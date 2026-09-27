/**
 * A backtest is only as honest as its dates.
 *
 * Every figure must exist from the day it was filed and not a day earlier; a
 * restatement is a new fact, not a correction of the past; twelve months are
 * built the way the filings add up; and a share count from before a split is
 * on the old basis. These tests build filings whose right answers are known.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractLine, fiscalYears, instantAt, knownOn, latestInstant, trailingTwelveMonths, type Fact,
} from '../src/data/edgar-facts.js';
import { parseConstituentRows } from '../src/data/universe.js';
import { indexAtOrBefore, splitFactorAfter } from '../src/backtest/prices.js';
import { crossSectionPeers } from '../src/backtest/peers.js';
import { monthEnds } from '../src/backtest/run.js';
import type { StockFinancials } from '../src/types.js';

const d = (start: string | null, end: string, val: number, filed: string): Fact => ({ start, end, val, filed });

describe('filings as they were known', () => {
  const raw = {
    cik: 1, entityName: 'X',
    facts: {
      'us-gaap': {
        SalesRevenueNet: { units: { USD: [
          { start: '2017-01-01', end: '2017-12-31', val: 90, filed: '2018-02-20', form: '10-K' },
          { start: '2017-01-01', end: '2017-12-31', val: 90, filed: '2019-02-20', form: '10-K' },   // comparative
        ] } },
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
          { start: '2018-01-01', end: '2018-12-31', val: 100, filed: '2019-02-20', form: '10-K' },
          { start: '2018-01-01', end: '2018-12-31', val: 97, filed: '2019-08-01', form: '10-K/A' },  // restated
          { start: '2018-01-01', end: '2018-12-31', val: 97, filed: '2020-02-20', form: '10-K' },   // comparative
          { start: '2019-01-01', end: '2019-03-31', val: 30, filed: '2019-04-30', form: '8-K' },    // press release
        ] } },
      },
    },
  };

  it('follows a renamed tag, keeps a restatement, and drops the comparatives that repeat', () => {
    const facts = extractLine(raw as never, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']);
    assert.deepEqual(facts.map((f) => [f.end, f.val, f.filed]), [
      ['2017-12-31', 90, '2018-02-20'],
      ['2018-12-31', 100, '2019-02-20'],
      ['2018-12-31', 97, '2019-08-01'],
    ]);
  });

  it('keeps a quarter\'s first filing under an old tag when a later filing reports it under the new one', () => {
    const renamed = {
      cik: 1, entityName: 'X', facts: { 'us-gaap': {
        SalesRevenueNet: { units: { USD: [{ start: '2017-07-01', end: '2017-09-30', val: 50, filed: '2017-11-01', form: '10-Q' }] } },
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
          { start: '2017-07-01', end: '2017-09-30', val: 50, filed: '2018-11-01', form: '10-Q' },
        ] } },
      } },
    };
    const facts = extractLine(renamed as never, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']);
    assert.equal(knownOn(facts, '2018-01-31').at(-1)?.val, 50, 'known from November 2017, not from 2018');
  });

  it('knows a figure from the day after it was filed, and the restatement only from its own day', () => {
    const facts = extractLine(raw as never, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']);
    assert.equal(knownOn(facts, '2019-02-20').at(-1)?.end, '2017-12-31', 'not on the filing day itself');
    assert.equal(knownOn(facts, '2019-03-01').at(-1)?.val, 100);
    assert.equal(knownOn(facts, '2019-09-01').at(-1)?.val, 97);
  });
});

describe('twelve months from the filings', () => {
  const revenue: Fact[] = [
    d('2018-01-01', '2018-12-31', 100, '2019-02-20'),
    d('2019-01-01', '2019-03-31', 30, '2019-04-30'),
    d('2019-01-01', '2019-06-30', 55, '2019-07-30'),
    d('2019-04-01', '2019-06-30', 25, '2019-07-30'),
    d('2018-01-01', '2018-03-31', 22, '2018-04-30'),
    d('2018-01-01', '2018-06-30', 48, '2018-07-30'),
    d('2019-01-01', '2019-12-31', 120, '2020-02-20'),
  ];

  it('is the fiscal year right after a 10-K', () => {
    assert.deepEqual(trailingTwelveMonths(revenue, '2019-03-01'), { value: 100, end: '2018-12-31' });
    assert.deepEqual(trailingTwelveMonths(revenue, '2020-03-01'), { value: 120, end: '2019-12-31' });
  });

  it('adds the year to date to the last year and takes last year\'s year to date away', () => {
    // Q1: 100 + 30 − 22
    assert.deepEqual(trailingTwelveMonths(revenue, '2019-05-01'), { value: 108, end: '2019-03-31' });
    // H1: 100 + 55 − 48
    assert.deepEqual(trailingTwelveMonths(revenue, '2019-08-01'), { value: 107, end: '2019-06-30' });
  });

  it('falls back to the fiscal year when the year-ago piece is missing', () => {
    const gap = revenue.filter((f) => f.end !== '2018-03-31');
    assert.deepEqual(trailingTwelveMonths(gap, '2019-05-01'), { value: 100, end: '2018-12-31' });
  });

  it('reads fiscal years and balance-sheet dates as they stood', () => {
    assert.deepEqual(fiscalYears(revenue, '2020-03-01').map((y) => y.value), [100, 120]);
    const assets = [d(null, '2018-12-31', 500, '2019-02-20'), d(null, '2019-06-30', 520, '2019-07-30')];
    assert.equal(latestInstant(assets, '2019-07-01')?.val, 500);
    assert.equal(latestInstant(assets, '2019-08-01')?.val, 520);
    assert.equal(instantAt(assets, '2019-01-05', '2019-08-01'), 500);
  });
});

describe('prices and splits', () => {
  it('finds the last session on or before a day', () => {
    const dates = ['2020-01-02', '2020-01-03', '2020-01-06'];
    assert.equal(indexAtOrBefore(dates, '2020-01-05'), 1);
    assert.equal(indexAtOrBefore(dates, '2020-01-01'), -1);
  });

  it('puts a share count reported before a split on today\'s basis', () => {
    const splits = [{ date: '2014-06-09', ratio: 7 }, { date: '2020-08-31', ratio: 4 }];
    assert.equal(splitFactorAfter(splits, '2013-12-31'), 28);
    assert.equal(splitFactorAfter(splits, '2019-12-31'), 4);
    assert.equal(splitFactorAfter(splits, '2021-01-01'), 1);
  });

  it('forms at the last session of every month', () => {
    const dates = ['2020-01-30', '2020-01-31', '2020-02-03', '2020-02-28', '2020-03-02'];
    assert.deepEqual(monthEnds(dates, '2020-01-01', '2020-02-29'), ['2020-01-31', '2020-02-28']);
  });
});

describe('peers from the cross-section', () => {
  const stock = (symbol: string, sub: string, cap: number, pe: number, extra: Partial<StockFinancials> = {}) => ({
    symbol, sector: 'Financials', subIndustry: sub,
    financials: { marketCap: cap, peRatio: pe, sector: 'Financial Services', industry: sub, ...extra } as StockFinancials,
  });

  it('takes the sub-industry, and the sector where the sub-industry is too thin', () => {
    const peers = crossSectionPeers([
      stock('A', 'Asset Management', 100, 10), stock('B', 'Asset Management', 100, 20),
      stock('C', 'Asset Management', 100, 30), stock('D', 'Asset Management', 100, 40),
      stock('E', 'Exchanges', 100, 50),
    ]);
    assert.equal(peers.get('A')?.pe, 30, 'B, C, D');
    assert.equal(peers.get('E')?.pe, 25, 'the whole sector for a sub-industry of one');
  });

  it('gives a lender its sub-industry or no group at all', () => {
    const peers = crossSectionPeers([
      stock('BANK', 'Banks - Regional', 100, 10, { industry: 'Banks - Regional' }),
      stock('X', 'Asset Management', 100, 20), stock('Y', 'Asset Management', 100, 30), stock('Z', 'Asset Management', 100, 40),
    ]);
    assert.equal(peers.get('BANK'), null);
  });

  it('leaves out peers a fiftieth of the company\'s size', () => {
    const peers = crossSectionPeers([
      stock('BIG', 'S', 1000, 10), stock('P1', 'S', 100, 20), stock('P2', 'S', 100, 30),
      stock('P3', 'S', 100, 40), stock('TINY', 'S', 1, 500),
    ]);
    assert.deepEqual(peers.get('BIG')?.peers, ['P1', 'P2', 'P3']);
  });
});

describe('the index file for the backtest', () => {
  it('reads GICS, the day a company joined and its CIK', () => {
    const csv = [
      'Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded',
      'BRK.B,Berkshire Hathaway,Financials,Multi-Sector Holdings,"Omaha, Nebraska",2010-02-16,1067983,1839',
      'MMM,3M,Industrials,Industrial Conglomerates,"Saint Paul, Minnesota",,66740,1902',
    ].join('\n');
    assert.deepEqual(parseConstituentRows(csv), [
      { symbol: 'BRK-B', name: 'Berkshire Hathaway', sector: 'Financials', subIndustry: 'Multi-Sector Holdings', added: '2010-02-16', cik: '1067983' },
      { symbol: 'MMM', name: '3M', sector: 'Industrials', subIndustry: 'Industrial Conglomerates', added: null, cik: '66740' },
    ]);
  });
});
