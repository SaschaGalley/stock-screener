/**
 * The S&P 1500 as the backtest reads it: the members of the 400 and the 600
 * off their Wikipedia tables, the day each joined the composite — a move
 * between the three is no new entry — and the insiders' trades before a day.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compositeJoinDates, departedMembers, parseIndexChanges, parseIndexMembers, sameCompany, wikiDate,
  type Constituent, type CompositeIndex, type IndexChange,
} from '../src/data/universe.js';
import { insiderActivity, type InsiderTrade } from '../src/analysis/insider-signals.js';

const members400 = `
{| class="wikitable sortable sticky-header" id="constituents"
|-
! style="border-color:inherit;" | [[Symbol]]
! style="border-color:inherit;" | [[Public company|Security]]
! [[Global Industry Classification Standard|GICS]] Sector
! GICS Sub-Industry
! Headquarters Location
! [[SEC filings]]
|-
| style="border-color:inherit;" | {{NyseSymbol|AA}}
| style="border-color:inherit;" | [[Alcoa]]
| Materials
| Aluminum
| [[Pittsburgh]], Pennsylvania
| [https://www.sec.gov/cgi-bin/browse-edgar?CIK=AA&action=getcompany reports]
|-
| style="border-color:inherit;" | {{NasdaqSymbol|AAL}}
| style="border-color:inherit;" | [[American Airlines Group]]
| Industrials
| Passenger Airlines
| [[Fort Worth, Texas]]
| [https://www.sec.gov/cgi-bin/browse-edgar?CIK=6201&action=getcompany reports]
|}`;

const members600 = `
{| class="wikitable sortable mw-collapsible sticky-header" id="constituents"
|-
! [[Ticker symbol|Symbol]]
! [[Public company|Security]]
! [[Global Industry Classification Standard|GICS]] Sector
! GICS Sub-Industry
! Headquarters Location
! [[SEC filings]]
! [[Central Index Key|CIK]]
|-
|{{Anchor|A}}{{NyseSymbol|AAMI}}
|[[Acadian Asset Management|Acadian Asset Management Inc.]]
| Financials
| Asset Management & Custody Banks
|[[Boston]], Massachusetts
| [https://www.sec.gov/edgar/browse/?CIK=0001748824 view]
|0001748824
|}`;

const changes = `
{|  class="wikitable sortable" id="changes"
|-
! rowspan="2" | Date
! colspan="2" | Added
! colspan="2" | Removed
! rowspan="2" | Reason
|-
! Ticker || Security ||  Ticker ||  Security
|-
|September 21, 2026 || HUBS || [[HubSpot]] || SAM || [[Boston Beer Company]] || Market capitalization change.
|-
|| Jan 9, 2012
|| CRI
|| Carter's
|| NDN
|| 99 Cents Only
|| Acquired.
|}`;

describe('the S&P 400 and 600 off Wikipedia', () => {
  it('reads the symbol out of its template and the CIK from wherever the table keeps it', () => {
    assert.deepEqual(parseIndexMembers(members400, 'sp400').map((m) => [m.symbol, m.sector, m.cik]), [
      ['AA', 'Materials', null], ['AAL', 'Industrials', '6201'],
    ]);
    assert.deepEqual(parseIndexMembers(members600, 'sp600').map((m) => [m.symbol, m.subIndustry, m.cik]), [
      ['AAMI', 'Asset Management & Custody Banks', '0001748824'],
    ]);
  });

  it('reads the changes, both row layouts', () => {
    assert.deepEqual(parseIndexChanges(changes), [
      { day: '2026-09-21', added: 'HUBS', removed: 'SAM', removedName: 'Boston Beer Company' },
      { day: '2012-01-09', added: 'CRI', removed: 'NDN', removedName: '99 Cents Only' },
    ]);
    assert.equal(wikiDate('Sept. 3, 2019'), '2019-09-03');
    assert.equal(wikiDate('soon'), null);
  });
});

describe('the day a company joined the composite', () => {
  const m = (symbol: string, index: CompositeIndex, added: string | null = null): Constituent =>
    ({ symbol, name: symbol, sector: '', subIndustry: '', added, cik: '1', index });
  const table = new Map<CompositeIndex, IndexChange[]>([
    ['sp500', [{ day: '2020-06-22', added: 'UP', removed: 'X' }]],
    ['sp400', [
      { day: '2016-03-01', added: 'UP', removed: 'Y' },
      { day: '2020-06-22', added: 'Z', removed: 'UP' },
      { day: '2018-05-01', added: 'MID', removed: 'W' },
      { day: '2012-01-13', added: 'Q', removed: 'R' },
    ]],
    ['sp600', [{ day: '2019-12-17', added: 'P', removed: 'V' }]],
  ]);

  it('follows a move back to the index it came from', () => {
    const days = compositeJoinDates([m('UP', 'sp500', '2020-06-22'), m('MID', 'sp400'), m('OLD', 'sp400'), m('SMALL', 'sp600')], table);
    assert.equal(days.get('UP'), '2016-03-01');      // joined the 400 in 2016, moved up in 2020
    assert.equal(days.get('MID'), '2018-05-01');     // its own addition
    assert.equal(days.get('OLD'), '2012-01-13');     // never listed: a member since the 400's table begins
    assert.equal(days.get('SMALL'), '2019-12-17');   // the 600's table begins late; counted from then, not from 2013
  });
});

describe('the companies that left', () => {
  const table = new Map<CompositeIndex, IndexChange[]>([
    ['sp500', [
      { day: '2015-03-02', added: 'NEW', removed: 'DOWN', removedName: 'Down Corp' },
      { day: '2010-01-04', added: 'DOWN', removed: 'Q' },
    ]],
    ['sp400', [
      { day: '2015-03-02', added: 'DOWN', removed: 'Z' },                      // moved to the 400 …
      { day: '2019-05-01', added: 'Y', removed: 'DOWN', removedName: 'Down Corporation' },  // … and out of the composite
      { day: '2012-06-01', added: 'GONE', removed: 'W' },
      { day: '2016-08-01', added: 'V', removed: 'GONE', removedName: 'Gone Holdings' },
      { day: '2011-01-01', added: 'X', removed: 'EARLY', removedName: 'Early' },
    ]],
  ]);

  it('takes each ticker\'s last exit and its way in, and skips those out before the start', () => {
    // Everyone else in the table is a member today.
    const d = departedMembers(new Set(['NEW', 'Q', 'Z', 'Y', 'W', 'V', 'X']), table, '2013-01-01');
    assert.deepEqual(d.map((x) => [x.symbol, x.index, x.added, x.removed, x.name]), [
      ['DOWN', 'sp400', '2010-01-04', '2019-05-01', 'Down Corporation'],   // in via the 500 in 2010
      ['GONE', 'sp400', '2012-06-01', '2016-08-01', 'Gone Holdings'],
    ]);
  });

  it('tells a company from the one that took its ticker', () => {
    assert.equal(sameCompany('ANADARKO PETROLEUM CORP', 'Anadarko Petroleum'), true);
    assert.equal(sameCompany('ARKO Petroleum Corp.', 'Anadarko Petroleum'), false);
    assert.equal(sameCompany('MOLSON COORS BEVERAGE CO', 'Molson Coors'), true);
    assert.equal(sameCompany('The Boston Beer Company', 'Boston Beer Company'), true);
  });
});

describe('the insiders before a day', () => {
  const t = (filingDate: string, name: string, code: string, change: number, price = 10, derivative = false): InsiderTrade =>
    ({ filingDate, name, code, change, price, derivative });

  it('counts different buyers and sellers filed in the half year before, the day itself excluded', () => {
    const a = insiderActivity([
      t('2025-01-10', 'CEO', 'P', 1000),
      t('2025-02-10', 'CEO', 'P', 500),             // the same buyer again
      t('2025-03-01', 'CFO', 'P', 200),
      t('2025-03-05', 'Director', 'S', -300),
      t('2025-03-05', 'Director', 'M', 300),        // an exercise is not a view
      t('2025-03-06', 'COO', 'P', 100, 10, true),   // derivative
      t('2025-04-01', 'Chair', 'P', 999),           // filed on the day: not yet known
      t('2024-06-01', 'Old', 'P', 999),             // older than the window
    ], '2025-04-01');
    assert.deepEqual(a, { buyers: 2, sellers: 1, net: 1 / 3, buyValue: 17_000 });
  });

  it('has no net reading without trades', () => {
    assert.equal(insiderActivity([], '2025-04-01').net, null);
  });
});
