/**
 * The reference universe is the index as a file says it is: every member,
 * spelt the way Yahoo spells it, and nothing a malformed row could smuggle in.
 * The pacing that lets several hundred of them through Finnhub's minute is
 * tested on a clock that does not tick by itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPOSITE_INDEXES, csvRecord, parseConstituents, parseWikiTickers, UNIVERSE_SOURCES, universeIndices, yahooTicker,
} from '../src/data/universe.js';
import { activeMembers, nextMembership, unionMembers } from '../src/universe.js';
import { RateWindow } from '../src/utils/rate-window.js';
import { settledPool } from '../src/utils/pool.js';

describe('constituents', () => {
  const csv = [
    'Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded',
    'MMM,3M,Industrials,Industrial Conglomerates,"Saint Paul, Minnesota",1957-03-04,66740,1902',
    'BRK.B,Berkshire Hathaway,Financials,Multi-Sector Holdings,"Omaha, Nebraska",2010-02-16,1067983,1839',
    'BF.B,Brown–Forman,Consumer Staples,Distillers & Vintners,"Louisville, Kentucky",1982-10-31,14693,1870',
    ',,,,,,,',
    'MMM,3M again,Industrials,,,,,',
  ].join('\n');

  it('keeps a quoted field with a comma in it whole', () => {
    assert.deepEqual(csvRecord('A,"Saint Paul, Minnesota",B'), ['A', 'Saint Paul, Minnesota', 'B']);
    assert.deepEqual(csvRecord('"say ""hi""",x'), ['say "hi"', 'x']);
  });

  it('reads the symbol column by name, in Yahoo\'s spelling, once each', () => {
    assert.deepEqual(parseConstituents(csv), ['BF-B', 'BRK-B', 'MMM']);
  });

  it('reads the column wherever the file puts it', () => {
    assert.deepEqual(parseConstituents('Name,Symbol\n"Apple, Inc.",AAPL\n'), ['AAPL']);
  });

  it('reads nothing from a file without a symbol column', () => {
    assert.deepEqual(parseConstituents('Ticker,Name\nAAPL,Apple\n'), []);
  });

  it('spells share classes the way Yahoo quotes them', () => {
    assert.equal(yahooTicker(' brk.b '), 'BRK-B');
  });
});

describe('pacing', () => {
  /** A clock that only moves when someone sleeps on it. */
  function clock() {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => { slept.push(ms); t += ms; },
      slept,
    };
  }

  it('lets a burst through up to the limit, then waits for the oldest call to age out', async () => {
    const c = clock();
    const w = new RateWindow(3, 1000, c.now, c.sleep);
    for (let i = 0; i < 3; i++) await w.take();
    assert.deepEqual(c.slept, []);
    await w.take();
    assert.deepEqual(c.slept, [1000]);
  });

  it('serves waiters in the order they came', async () => {
    const c = clock();
    const w = new RateWindow(1, 100, c.now, c.sleep);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => w.take().then(() => order.push(i))));
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(c.now(), 200);
  });
});

describe('the reference pool', () => {
  it('never has more than its size in flight, and keeps every outcome', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await settledPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (n === 4) throw new Error('delisted');
      return n * 10;
    });
    assert.equal(peak, 3);
    assert.equal(out.length, 7);
    assert.equal(out.filter((o) => o.status === 'rejected').length, 1);
  });

  it('starts nothing new once the run is stopped', async () => {
    const started: number[] = [];
    let checks = 0;
    await settledPool([1, 2, 3, 4, 5], 1, async (n) => { started.push(n); }, async () => ++checks <= 2);
    assert.deepEqual(started, [1, 2]);
  });
});

describe('European indices from Wikipedia', () => {
  const eurostoxx = [
    '{| class="wikitable sortable" id="constituents" style="white-space: nowrap"',
    '! Ticker !! Main listing !! Name !! Corporate form',
    '|-',
    "|ADS.DE || {{Flagicon|Germany}} {{FWB|ADS}} || [[Adidas]] || ''[[Aktiengesellschaft]]''",
    '|-',
    '|AIR.PA || {{Flagicon|France}} {{EuronextParis|AIR|NL0000235190|XPAR}} || [[Airbus]] || SE',
    '|-',
    '|DBK.DE',
    '|{{Flagicon|Germany}} {{FWB|DBK}}',
    '|[[Deutsche Bank]]',
    '|AG',
    '|}',
  ].join('\n');
  const dax = [
    '{| class="wikitable sortable" id="Zusammensetzung"',
    '|-',
    '! Name',
    '!Symbol!! Branche !!class="unsortable"| Logo !! [[Indexgewichtung|Indexgewicht]] in %',
    '|-',
    '| [[Adidas]]',
    '|ADS|| Sportartikel || style="text-align:center" | [[Datei:Adidas.svg|120x40px]] ||style="text-align:center"| 2,500',
    '|-',
    '| [[Allianz SE|Allianz]]',
    '|ALV|| Versicherungen ||style="text-align:center"| [[Datei:Allianz.svg|120x40px]] ||style="text-align:center"| 8,411',
    '|}',
  ].join('\n');

  it('reads the ticker column, whether a row sits on one line or on several', () => {
    assert.deepEqual(parseWikiTickers(eurostoxx, { tableId: 'constituents', column: 'Ticker' }), ['ADS.DE', 'AIR.PA', 'DBK.DE']);
  });

  it('adds the exchange where the table gives only the Xetra symbol', () => {
    assert.deepEqual(parseWikiTickers(dax, { tableId: 'Zusammensetzung', column: 'Symbol', suffix: '.DE' }), ['ADS.DE', 'ALV.DE']);
  });

  it('reads nothing from a page without the table', () => {
    assert.deepEqual(parseWikiTickers('no table here', { tableId: 'constituents', column: 'ticker' }), []);
  });
});

describe('membership', () => {
  it('counts a company once when two indices list it on different exchanges', () => {
    const all = unionMembers({ sp500: ['EL', 'MMM'], eurostoxx50: ['AIR.PA', 'EL.PA', 'SAN.MC', 'SAN.PA'], dax: ['AIR.DE', 'SAP.DE'] });
    assert.deepEqual(all, ['EL', 'MMM', 'AIR.PA', 'EL.PA', 'SAN.MC', 'SAN.PA', 'SAP.DE']);
  });

  it('keeps an index\'s last list when its fetch fails, so an outage is not an exodus', () => {
    const prev = { bySource: { sp500: ['A', 'B'], eurostoxx50: ['AIR.PA'] }, departed: {} };
    const next = nextMembership(prev, { sp500: ['A', 'B'], eurostoxx50: null, dax: null }, '2026-09-27');
    assert.deepEqual(next.bySource.eurostoxx50, ['AIR.PA']);
    assert.deepEqual(next.departed, {});
  });

  it('records who left, scores them for the grace period, and forgets a departure that reverses', () => {
    const prev = { bySource: { sp500: ['A', 'B', 'C'] }, departed: {} };
    const left = nextMembership(prev, { sp500: ['A', 'C'], eurostoxx50: [], dax: [] }, '2026-09-27');
    assert.deepEqual(left.departed, { B: '2026-09-27' });
    assert.ok(activeMembers(left, '2026-10-27').includes('B'), 'still scored a month later');
    assert.ok(!activeMembers(left, '2027-01-27').includes('B'), 'gone after the quarter');
    const back = nextMembership(left, { sp500: ['A', 'B', 'C'], eurostoxx50: [], dax: [] }, '2026-10-01');
    assert.deepEqual(back.departed, {});
  });
});

describe('the indices', () => {
  it('are the S&P 1500 the backtest measures on, and the two European ones', () => {
    assert.deepEqual(UNIVERSE_SOURCES.map((x) => x.key), [...COMPOSITE_INDEXES.map((x) => x.key), 'eurostoxx50', 'dax']);
    assert.equal(universeIndices(), 'S&P 500, S&P MidCap 400, S&P SmallCap 600, EURO STOXX 50 und DAX');
  });

  it('count a company moving between two of them once', () => {
    assert.deepEqual(unionMembers({ sp400: ['AAON', 'MOVE'], sp500: ['AAPL', 'MOVE'] }), ['AAPL', 'MOVE', 'AAON']);
  });
});
