/** A made-up depot looked through its made-up funds. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { strToU8, zipSync } from 'fflate';

import { companyKey, lookThrough, OTHER, type FundHoldings } from '../src/analysis/look-through.js';
import { issuerDay, parseComposition, yahooSymbol } from '../src/data/fund-composition.js';
import { parseTopHoldings } from '../src/data/fund-holdings.js';
import { sheetRows } from '../src/data/xlsx.js';

const fund: FundHoldings = {
  symbol: 'WRLD', asOf: '2026-10-08', equity: 0.98, bonds: null, cash: 0.02, full: null,
  holdings: [
    { symbol: 'MADE', name: 'Made Up Corp', weight: 0.05 },
    { symbol: 'ALPC', name: 'Alpha Beta Inc Class C', weight: 0.02 },
    { symbol: 'OTHR', name: 'Other Holdings PLC', weight: 0.01 },
  ],
  sectors: [{ sector: 'Technology', weight: 0.4 }, { sector: 'Financial Services', weight: 0.6 }],
};

const positions = [
  { isin: 'XX0000000010', symbol: 'WRLD', name: 'Made Up World ETF', assetType: 'etf', sector: null, weight: 0.5 },
  { isin: 'XX0000000020', symbol: 'NOPE', name: 'Undescribed ETF', assetType: 'etf', sector: null, weight: 0.1 },
  { isin: 'XX0000000030', symbol: 'MADE', name: 'Made Up Corporation', assetType: 'stock', sector: 'Technology', weight: 0.2 },
  { isin: 'XX0000000040', symbol: 'ALPA', name: 'Alpha Beta Inc.', assetType: 'stock', sector: 'Communication Services', weight: 0.1 },
  { isin: 'XX0000000050', symbol: 'COIN-USD', name: 'Some Coin', assetType: 'crypto', sector: null, weight: 0.1 },
];

describe('the look-through', () => {
  const lt = lookThrough(positions, new Map([['XX0000000010', fund]]));
  const sector = (s: string) => lt.sectors.find((x) => x.sector === s)!;

  it('reads a fund as its sectors, scaled by its equity part and its weight', () => {
    assert.ok(Math.abs(sector('Technology').viaFunds - 0.5 * 0.98 * 0.4) < 1e-9);
    assert.ok(Math.abs(sector('Technology').direct - 0.2) < 1e-9);
    assert.ok(Math.abs(sector(OTHER.cash).total - 0.01) < 1e-9);
    assert.ok(Math.abs(sector(OTHER.unknown).total - 0.1) < 1e-9);
    assert.ok(Math.abs(sector(OTHER.crypto).total - 0.1) < 1e-9);
    assert.deepEqual(lt.unknown, ['NOPE']);
    assert.ok(Math.abs(lt.funds.weight - 0.6) < 1e-9 && Math.abs(lt.funds.known - 0.5) < 1e-9 && lt.funds.full === 0);
  });

  it('adds what the funds hold of a stock held, by ticker or by name across share classes', () => {
    assert.ok(Math.abs(lt.heldViaFunds.XX0000000030 - 0.025) < 1e-9);
    assert.ok(Math.abs(lt.heldViaFunds.XX0000000040 - 0.01) < 1e-9);
    const made = lt.stocks.find((x) => x.symbol === 'MADE')!;
    assert.equal(made.name, 'Made Up Corporation');
    assert.ok(made.held && Math.abs(made.total - 0.225) < 1e-9);
    assert.ok(!lt.stocks.find((x) => x.symbol === 'OTHR')!.held);
  });

  it("counts an issuer's full list by ISIN or ticker where the names differ", () => {
    const europe: FundHoldings = {
      symbol: 'EURO', asOf: '2026-10-07', equity: 1, bonds: null, cash: null, full: 'Amundi', sectors: [],
      holdings: [
        { isin: 'XX0000000060', symbol: null, name: 'AIR THING SA', weight: 0.012 },
        { isin: null, symbol: 'GLD.PA', name: 'GOLDEN WINGS GROUP', weight: 0.008 },
      ],
    };
    const held = [
      { isin: 'XX0000000070', symbol: 'EURO', name: 'Made Up Europe ETF', assetType: 'etf', sector: null, weight: 0.5 },
      { isin: 'XX0000000060', symbol: 'AIRT.DE', name: "L'Air Thing S.A.", assetType: 'stock', sector: 'Basic Materials', weight: 0.1 },
      { isin: 'XX0000000080', symbol: 'GLD.PA', name: 'Golden Wings SE', assetType: 'stock', sector: 'Industrials', weight: 0.1 },
    ];
    const x = lookThrough(held, new Map([['XX0000000070', europe]]));
    assert.ok(Math.abs(x.heldViaFunds.XX0000000060 - 0.006) < 1e-9);
    assert.ok(Math.abs(x.heldViaFunds.XX0000000080 - 0.004) < 1e-9);
    assert.equal(x.funds.full, 0.5);
    assert.equal(x.stocks.find((s) => s.symbol === 'AIRT.DE')?.name, "L'Air Thing S.A.");
  });

  it('finds a stock held in every fund, whichever fund comes first and however each names it', () => {
    const byIsin: FundHoldings = {
      symbol: 'EURO', asOf: '2026-10-07', equity: 1, bonds: null, cash: null, full: 'Amundi', sectors: [],
      holdings: [{ isin: 'XX0000000080', symbol: null, name: 'GOLDEN WINGS SE PARIS', weight: 0.008 }],
    };
    const byTicker: FundHoldings = {
      symbol: 'WRLD', asOf: '2026-10-07', equity: 1, bonds: null, cash: null, full: 'iShares', sectors: [],
      holdings: [{ isin: null, symbol: 'GLD.PA', name: 'GOLDEN WINGS GROUP', weight: 0.002 }],
    };
    const held = [
      { isin: 'XX0000000070', symbol: 'EURO', name: 'Made Up Europe ETF', assetType: 'etf', sector: null, weight: 0.5 },
      { isin: 'XX0000000010', symbol: 'WRLD', name: 'Made Up World ETF', assetType: 'etf', sector: null, weight: 0.4 },
      { isin: 'XX0000000080', symbol: 'GLD.PA', name: 'Golden Wings SE', assetType: 'stock', sector: 'Industrials', weight: 0.1 },
    ];
    const x = lookThrough(held, new Map([['XX0000000070', byIsin], ['XX0000000010', byTicker]]));
    assert.ok(Math.abs(x.heldViaFunds.XX0000000080 - (0.5 * 0.008 + 0.4 * 0.002)) < 1e-9);
  });

  it('names a company without its legal form or share class', () => {
    assert.equal(companyKey('Alpha Beta Inc Class C'), companyKey('Alpha Beta Inc.'));
    assert.equal(companyKey('Made Up Corp'), 'made up');
    assert.equal(companyKey("L'Air Thing S.A."), 'air thing');
    assert.equal(companyKey('AIR THING PRIME DE FIDELITE 2027'), 'air thing');
    assert.equal(companyKey('Société Générée SA'), companyKey('SOCIETE GENEREE'));
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

describe("the issuers' full lists", () => {
  it("reads Amundi's composition: shares only, with their ISIN", () => {
    const c = parseComposition('amundi', {
      compositionData: [
        { compositionCharacteristics: { date: '2026-10-07', type: 'EQUITY_ORDINARY', isin: 'XX0000000060', name: 'AIR THING SA' }, weight: 0.012 },
        { compositionCharacteristics: { date: '2026-10-07', type: 'PREFERENCE_SHARES', isin: 'XX0000000090', name: 'MADE UP PREF' }, weight: 0.002 },
        { compositionCharacteristics: { date: '2026-10-07', type: 'CASH', isin: null, name: null }, weight: 0.005 },
        { compositionCharacteristics: { date: '2026-10-07', type: 'FUTURE', isin: 'XX0000000100', name: 'SOME INDEX 12/26' }, weight: -0.0001 },
      ],
    });
    assert.equal(c?.asOf, '2026-10-07');
    assert.deepEqual(c?.holdings.map((h) => [h.isin, h.weight]), [['XX0000000060', 0.012], ['XX0000000090', 0.002]]);
    assert.equal(parseComposition('amundi', { compositionData: [] }), null);
  });

  it("reads iShares' file: German numbers, shares only, ticker and exchange as a Yahoo symbol", () => {
    const csv = '\uFEFFFondsposition per,"07.Okt.2026"\n\n'
      + 'Emittententicker,Name,Sektor,Anlageklasse,Marktwert,Gewichtung (%),Nominalwert,Nominale,Kurs,Standort,Börse,Marktwährung\n'
      + '"GLD","GOLDEN WINGS GROUP","Industrie","Aktien","1.234.567,00","1,25","1","1","1","Frankreich","Nyse Euronext - Euronext Paris","EUR"\n'
      + '"MADE B","MADE UP CLASS B","IT","Aktien","1,00","0,50","1","1","1","Vereinigte Staaten","New York Stock Exchange Inc.","USD"\n'
      + '"XYZ6","SOME INDEX DEC 26","Barmittel & Derivate","Futures","0,00","0,00","1","1","1","-","Eurex Deutschland","EUR"\n';
    const c = parseComposition('ishares', { portfolioId: '1', csv });
    assert.equal(c?.asOf, '2026-10-07');
    assert.deepEqual(c?.holdings.map((h) => [h.symbol, h.weight]), [['GLD.PA', 0.0125], ['MADE-B', 0.005]]);
  });

  it("reads SPDR's sheet from the header on, by ISIN", () => {
    const rows = [
      ['Fund Name:', 'Made Up World UCITS ETF'], ['Holdings As Of:', '07-Oct-2026'], [],
      ['ISIN', 'SEDOL', 'Security Name', 'Currency', 'Number of Shares', 'Percent of Fund'],
      ['XX0000000030', '1', 'Made Up Corporation', 'USD', '10', '2.5'],
      ['Unassigned', 'Unassigned', 'CNY:HKD 20250930', 'CNY', '-1', '-4.0E-5'],
    ];
    const c = parseComposition('spdr', { ticker: 'made-gy', rows });
    assert.equal(c?.asOf, '2026-10-07');
    assert.deepEqual(c?.holdings, [{ isin: 'XX0000000030', symbol: null, name: 'Made Up Corporation', weight: 0.025 }]);
  });

  it('reads a workbook by its cells, shared and inline strings and numbers', () => {
    const file = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>ISIN</t></si><si><r><t>Made Up </t></r><r><t>&amp; Co</t></r></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
        + '<row r="2"><c r="A2" t="inlineStr"><is><t>XX0000000030</t></is></c><c r="B2"><v>2.5</v></c></row></sheetData></worksheet>'),
    });
    assert.deepEqual(sheetRows(file), [['ISIN', '', 'Made Up & Co'], ['XX0000000030', '2.5']]);
  });

  it('turns an exchange listing into the Yahoo symbol, and the issuers\' days into dates', () => {
    assert.equal(yahooSymbol('NOVO B', 'Omx Nordic Exchange Copenhagen A/S'), 'NOVO-B.CO');
    assert.equal(yahooSymbol('RR.', 'London Stock Exchange'), 'RR.L');
    assert.equal(yahooSymbol('700', 'Hong Kong Exchanges And Clearing Ltd'), '0700.HK');
    assert.equal(yahooSymbol('ABC', 'Xetra'), 'ABC.DE');
    assert.equal(yahooSymbol('ABC', 'Somewhere Else'), null);
    assert.equal(issuerDay('07.Okt.2026'), '2026-10-07');
    assert.equal(issuerDay('7-Mar-2026'), '2026-03-07');
    assert.equal(issuerDay('03.Mär.2026'), '2026-03-03');
  });
});
