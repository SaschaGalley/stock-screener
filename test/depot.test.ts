/**
 * The depot weighed against the model, on made-up trades. Positions are
 * summed at moving-average cost, as umsatz keeps them; what comes out is a
 * list of things to look at, never a target weight.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { depotView, positionsFromTrades, type HeldPosition } from '../src/analysis/depot.js';
import type { Trade } from '../src/journal.js';

let id = 0;
const trade = (isin: string, symbol: string | null, kind: Trade['kind'], day: string, quantity: number, price: number, extra: Partial<Trade> = {}): Trade => ({
  id: ++id, day, isin, symbol, name: `${symbol ?? isin} Corp`, assetType: 'stock', kind, quantity, price, currency: 'EUR', ...extra,
});

describe('positions from trades', () => {
  it('averages the cost, takes a sale out at that average, and starts over after zero', () => {
    const p = positionsFromTrades([
      trade('XX1', 'AAA', 'buy', '2026-01-02', 10, 100),
      trade('XX1', 'AAA', 'buy', '2026-02-02', 10, 200),
      trade('XX1', 'AAA', 'sell', '2026-03-02', 5, 300),
      trade('XX2', 'BBB', 'buy', '2026-01-05', 4, 50),
      trade('XX2', 'BBB', 'sell', '2026-02-05', 4, 60),
      trade('XX2', 'BBB', 'buy', '2026-04-05', 2, 70),
    ]);
    const a = p.find((x) => x.isin === 'XX1')!;
    assert.equal(a.quantity, 15);
    assert.equal(a.costEur, 15 * 150);
    assert.equal(a.openedAt, '2026-01-02');
    const b = p.find((x) => x.isin === 'XX2')!;
    assert.equal(b.quantity, 2);
    assert.equal(b.costEur, 140);
    assert.equal(b.openedAt, '2026-04-05');
  });

  it('counts savings plans and spin-offs as shares in, and drops what was sold out', () => {
    const p = positionsFromTrades([
      trade('XX3', null, 'savings-plan', '2026-01-02', 0.5, 100, { assetType: 'etf' }),
      trade('XX4', 'SPIN', 'spin-off', '2026-02-02', 3, 10),
      trade('XX5', 'GONE', 'buy', '2026-01-02', 1, 10),
      trade('XX5', 'GONE', 'sell', '2026-01-03', 1, 12),
    ]);
    assert.deepEqual(p.map((x) => x.isin).sort(), ['XX3', 'XX4']);
  });

  it('gives no euro cost for a position bought in another currency', () => {
    const [p] = positionsFromTrades([trade('XX6', 'USD1', 'buy', '2026-01-02', 1, 10, { currency: 'USD' })]);
    assert.equal(p.costEur, null);
  });
});

describe('the depot against the model', () => {
  const held: HeldPosition[] = positionsFromTrades([
    trade('XA', 'BIG', 'buy', '2026-01-02', 10, 100),
    trade('XB', 'BAD', 'buy', '2026-01-02', 10, 10),
    trade('XC', 'GOOD', 'buy', '2026-01-02', 10, 10),
    trade('XD', 'OUT', 'buy', '2026-01-02', 10, 10),
    trade('XE', null, 'savings-plan', '2026-01-02', 1, 50, { assetType: 'etf' }),
  ]);
  const prices = new Map([
    ['XA', { day: '2026-10-02', priceEur: 120 }], ['XB', { day: '2026-10-02', priceEur: 10 }],
    ['XC', { day: '2026-10-02', priceEur: 10 }], ['XD', { day: '2026-10-02', priceEur: 10 }],
  ]);
  const model = new Map([
    ['BIG', { score: 5, verdict: 'HOLD', sector: 'Technology', name: 'Big' }],
    ['BAD', { score: 2.4, verdict: 'SELL', sector: 'Technology', name: 'Bad' }],
    ['GOOD', { score: 7, verdict: 'BUY', sector: 'Energy', name: 'Good' }],
    ['NEW', { score: 8.2, verdict: 'STRONG BUY', sector: 'Energy', name: 'New' }],
  ]);
  const v = depotView({
    held, prices, model,
    reasons: (p) => (p.symbol === 'BIG' ? { entryId: 1, day: '2026-01-02', headline: 'why' } : null),
    theses: new Map([['BIG', { contradicted: 1, total: 3, at: '2026-09-01' }]]),
  });
  const flags = (s: string) => v.positions.find((p) => (p.symbol ?? p.isin) === s)!.flags.map((f) => `${f.tone}: ${f.text}`);

  it('weighs at umsatz prices and leaves an unpriced position out of the total', () => {
    assert.equal(v.totalEur, 1200 + 100 + 100 + 100);
    assert.equal(v.unvalued, 1);
    assert.equal(v.positions[0].symbol, 'BIG');
    assert.ok(Math.abs(v.positions[0].gain! - 0.2) < 1e-12);
  });

  it('names a concentration, a sell verdict, a contradicted thesis and a missing reason', () => {
    assert.deepEqual(flags('BIG'), ['reduce: Klumpen: 80 % des Depots', 'reduce: Thesen-Check: 1 von 3 widerlegt']);
    assert.deepEqual(flags('BAD'), ['reduce: Modell-Urteil SELL (2,4)', 'ask: keine Begründung im Journal']);
    assert.deepEqual(flags('GOOD'), ['add: Modell-Urteil BUY, unter dem Durchschnittsgewicht von 25 %', 'ask: keine Begründung im Journal']);
    assert.deepEqual(flags('OUT'), ['ask: keine Begründung im Journal', 'ask: nicht in der Watchlist — kein Score']);
    // A savings plan needs no reason; an ETF is no concentration.
    assert.deepEqual(flags('XE'), ['ask: kein Kurs aus umsatz']);
  });

  it('weighs the sectors among the stocks', () => {
    assert.equal(v.sectors[0].sector, 'Technology');
    // The stock outside the watchlist counts, under "ohne Sektor".
    assert.ok(Math.abs(v.sectors[0].weight - 1300 / 1500) < 1e-12);
    assert.ok(v.findings.some((f) => f.includes('in einem Sektor (Technology)')));
  });
});
