/**
 * The discover lists: which universe stocks each question names, and why.
 * Every ticker and figure here is invented.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analystsWarming, belowValue, bestScores, discoverUniverse, insiderBuying, lastTurn, onePerCompany, verdictTurns,
  type UniverseStock,
} from '../src/analysis/discover.js';

const NOW = new Date('2026-05-31T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const dayAgo = (days: number) => ago(days).slice(0, 10);

function stock(symbol: string, over: Partial<UniverseStock> = {}): UniverseStock {
  return {
    symbol, name: `${symbol} AG`, sector: 'Industrials', industry: 'Machinery', logoDomain: null, currency: 'EUR',
    price: 100, marketCap: 5e9, asOf: ago(2), score: 5, verdict: 'HOLD', pillars: [],
    fair: 100, fairP25: 90, undervalued: 0.5, confidence: 7, health: 6, distress: false, capped: false, stale: false,
    ...over,
  };
}

describe('one line per company', () => {
  it('drops a company listed under another ticker, and keeps the largest of its own lines', () => {
    const kept = onePerCompany([
      stock('BEISP.AS', { name: 'Beispiel N.V.' }),
      stock('KLASSE-B', { name: 'Klasse Corp', marketCap: 2e9 }),
      stock('KLASSE-A', { name: 'Klasse Corp', marketCap: 3e9 }),
      stock('EIGEN', { name: 'Eigen AG' }),
    ], ['Beispiel N.V.']);
    assert.deepEqual(kept.map((s) => s.symbol).sort(), ['EIGEN', 'KLASSE-A']);
  });
});

describe('best scores', () => {
  it('lists buy verdicts only, best first, with what carries and what holds back each', () => {
    const best = bestScores([
      stock('AAA', { score: 7.1, verdict: 'BUY', pillars: [
        { label: 'Bewertung', score: 8.2 }, { label: 'Qualität', score: 7.4 }, { label: 'Erwartungen', score: 2.1 },
      ] }),
      stock('BBB', { score: 8.4, verdict: 'STRONG BUY' }),
      stock('CCC', { score: 6.2, verdict: 'HOLD' }),
      stock('DDD', { score: null, verdict: null }),
    ]);
    assert.deepEqual(best.map((b) => b.symbol), ['BBB', 'AAA']);
    assert.deepEqual(best[1].strong, ['Bewertung', 'Qualität']);
    assert.deepEqual(best[1].weak, ['Erwartungen']);
  });
});

describe('verdict turns', () => {
  it('finds the last change inside the window, either way', () => {
    const turn = lastTurn([
      { at: ago(40), verdict: 'HOLD', score: 5.6 },
      { at: ago(12), verdict: 'HOLD', score: 6.2 },
      { at: ago(5), verdict: 'BUY', score: 6.9 },
      { at: ago(1), verdict: 'BUY', score: 7.0 },
    ], NOW);
    assert.deepEqual(turn, { day: dayAgo(5), from: 'HOLD', to: 'BUY', fromScore: 6.2, toScore: 6.9, up: true });

    const down = lastTurn([{ at: ago(9), verdict: 'HOLD', score: 4.6 }, { at: ago(3), verdict: 'SELL', score: 3.4 }], NOW);
    assert.equal(down?.up, false);
  });

  it('ignores a change older than the window and a stock that never changed', () => {
    assert.equal(lastTurn([{ at: ago(44), verdict: 'HOLD', score: 5 }, { at: ago(38), verdict: 'BUY', score: 6.8 }, { at: ago(2), verdict: 'BUY', score: 7 }], NOW), null);
    assert.equal(lastTurn([{ at: ago(20), verdict: 'HOLD', score: 5 }, { at: ago(2), verdict: 'HOLD', score: 5.4 }], NOW), null);
  });

  it('takes each day by its last reading', () => {
    const turn = lastTurn([
      { at: ago(10), verdict: 'HOLD', score: 6.4 },
      { at: `${dayAgo(4)}T06:00:00Z`, verdict: 'BUY', score: 6.6 },
      { at: `${dayAgo(4)}T22:00:00Z`, verdict: 'HOLD', score: 6.4 },
    ], NOW);
    assert.equal(turn, null);
  });

  it('puts the newest turn first', () => {
    const turns = verdictTurns(new Map([
      ['OLD', [{ at: ago(20), verdict: 'HOLD', score: 5 }, { at: ago(15), verdict: 'BUY', score: 6.7 }]],
      ['NEW', [{ at: ago(8), verdict: 'BUY', score: 6.6 }, { at: ago(2), verdict: 'HOLD', score: 6.3 }]],
    ]), NOW);
    assert.deepEqual(turns.map((t) => t.symbol), ['NEW', 'OLD']);
  });
});

describe('below value', () => {
  it('takes a wide gap only where the cautious models agree and nothing warns', () => {
    const cheap = belowValue([
      stock('OK1', { fair: 140, fairP25: 115 }),
      stock('OK2', { fair: 160, fairP25: 120 }),
      stock('NARROW', { fair: 115, fairP25: 105 }),
      stock('OUTLIER', { fair: 180, fairP25: 95 }),
      stock('TOO_GOOD', { fair: 260, fairP25: 180 }),
      stock('DISTRESS', { fair: 150, fairP25: 120, distress: true }),
      stock('CAPPED', { fair: 150, fairP25: 120, capped: true }),
      stock('WEAK', { fair: 150, fairP25: 120, health: 2.5 }),
      stock('UNSURE', { fair: 150, fairP25: 120, confidence: 3 }),
      stock('STALE', { fair: 150, fairP25: 120, stale: true }),
      stock('SOLD', { fair: 150, fairP25: 120, score: 3.6, verdict: 'SELL' }),
    ]);
    assert.deepEqual(cheap.map((c) => c.symbol), ['OK2', 'OK1']);
    assert.ok(Math.abs(cheap[0].gap - 0.6) < 1e-9);
  });
});

describe('insider buying', () => {
  it('counts recent open-market purchases and the people behind them', () => {
    const items = insiderBuying(new Map([
      ['ONE', [{ day: dayAgo(10), filer: 'Erika Muster', value: 250_000 }]],
      ['TWO', [
        { day: dayAgo(30), filer: 'Max Beispiel', value: 100_000 },
        { day: dayAgo(20), filer: 'Erika Muster', value: null },
        { day: dayAgo(5), filer: 'Max Beispiel', value: 50_000 },
      ]],
      ['OLD', [{ day: dayAgo(120), filer: 'Hans Probe', value: 900_000 }]],
    ]), NOW);
    assert.deepEqual(items.map((i) => i.symbol), ['TWO', 'ONE']);
    assert.deepEqual(items[0], { symbol: 'TWO', buys: 3, buyers: 2, value: 150_000, last: dayAgo(5) });
  });
});

describe('analysts warming', () => {
  it('weighs upgrades double, takes off the cuts, and needs more than a few raised targets', () => {
    const move = (days: number, firm: string, action: string | null, target: string | null) => ({ at: ago(days), firm, action, target });
    const items = analystsWarming(new Map([
      ['UP', [move(3, 'Firma A', 'up', 'Raises'), move(8, 'Firma B', 'main', 'Raises'), move(10, 'Firma D', 'main', 'Raises'), move(12, 'Firma C', 'main', 'Lowers')]],
      ['RAISES', [move(2, 'Firma A', 'main', 'Raises'), move(4, 'Firma B', 'main', 'Raises'), move(6, 'Firma C', 'main', 'Raises')]],
      ['MIXED', [move(2, 'Firma A', 'up', null), move(3, 'Firma B', 'down', null), move(4, 'Firma C', 'down', 'Raises'), move(5, 'Firma D', 'main', 'Raises'), move(6, 'Firma E', 'main', 'Raises'), move(7, 'Firma F', 'main', 'Raises')]],
      ['STALE', [move(45, 'Firma A', 'up', 'Raises'), move(50, 'Firma B', 'up', 'Raises')]],
    ]), NOW);
    assert.deepEqual(items.map((i) => i.symbol), ['UP']);
    assert.deepEqual(items[0], { symbol: 'UP', upgrades: 1, downgrades: 0, raises: 3, cuts: 1, firms: ['Firma A', 'Firma B', 'Firma D'], last: dayAgo(3) });
  });
});

describe('the whole page', () => {
  it('names each listed stock once, and only stocks of the universe', () => {
    const page = discoverUniverse({
      stocks: [stock('AAA', { score: 7.2, verdict: 'BUY', fair: 140, fairP25: 120 }), stock('BBB'), stock('CCC', { asOf: ago(6) })],
      verdicts: new Map([['ZZZ', [{ at: ago(9), verdict: 'HOLD', score: 5 }, { at: ago(2), verdict: 'BUY', score: 6.6 }]]]),
      moves: new Map(),
      buys: new Map([['BBB', [{ day: dayAgo(3), filer: 'Erika Muster', value: 10_000 }]]]),
      now: NOW,
    });
    assert.deepEqual(Object.keys(page.stocks).sort(), ['AAA', 'BBB']);
    assert.equal(page.turns.length, 0);
    assert.equal(page.size, 3);
    assert.equal(page.oldest, ago(6));
  });
});
