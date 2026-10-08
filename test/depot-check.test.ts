/**
 * The depot check on made-up stocks and a made-up depot: who is a candidate,
 * where each lands once analysed, and what of the depot the model is told.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyDepotCheck, managerInput, MANAGER_SYSTEM, selectCandidates,
  type CheckedStock, type DepotCheckSettings,
} from '../src/analysis/depot-check.js';

const settings: DepotCheckSettings = { minScore: 8, maxCandidates: 2, reduceBelow: 5 };

const stock = (symbol: string, score: number | null, over: Partial<CheckedStock> = {}): CheckedStock => ({
  symbol, name: `${symbol} Corp`, sector: 'Technology', score, verdict: null,
  scoreBefore: null, chart: null, weight: null, error: null, ...over,
});
const chart = (trend: 'up' | 'down' | 'sideways') => ({ trend, summary: `Trend ${trend}`, asOf: '2026-10-07' });

describe('candidates', () => {
  it('are the best stocks off the depot at or above the bar, at most as many as set', () => {
    const picked = selectCandidates(
      [stock('HELD', 9.5), stock('LOW', 7.9), stock('NONE', null), stock('B', 8.2), stock('A', 8.6), stock('C', 8.0)],
      new Set(['HELD']), settings,
    );
    assert.deepEqual(picked.map((c) => c.symbol), ['A', 'B']);
  });
});

describe('the lists', () => {
  const candidates = [
    stock('UP', 8.4, { verdict: 'STRONG BUY', chart: chart('up') }),
    stock('FLAT', 8.3, { verdict: 'STRONG BUY', chart: chart('sideways') }),
    stock('HELDBACK', 8.1, { verdict: 'HOLD', chart: chart('up') }),
    stock('FELL', 7.2, { verdict: 'BUY', chart: chart('up') }),
  ];
  const holdings = [
    stock('SINK', 3.1, { verdict: 'SELL', chart: chart('down'), weight: 0.04 }),
    stock('HOLDS', 4.2, { verdict: 'HOLD', chart: chart('up'), weight: 0.08 }),
    stock('BLIND', 4.8, { verdict: 'HOLD', chart: null, weight: 0.02 }),
    stock('FINE', 6.0, { verdict: 'HOLD', chart: chart('down'), weight: 0.10 }),
  ];
  const lists = classifyDepotCheck(candidates, holdings, settings);

  it('offer a buy only where the score held, the verdict is a buy and the chart rises', () => {
    assert.deepEqual(lists.buy.map((c) => c.symbol), ['UP']);
    assert.deepEqual(lists.waitForChart.map((c) => c.symbol), ['FLAT', 'HELDBACK']);
    assert.deepEqual(lists.dropped.map((c) => c.symbol), ['FELL']);
  });

  it('offer a reduction only where the score is weak and the chart falls', () => {
    assert.deepEqual(lists.reduce.map((c) => c.symbol), ['SINK']);
    assert.deepEqual(lists.watch.map((c) => c.symbol), ['HOLDS', 'BLIND'], 'weak, but no falling chart');
  });
});

describe('what the depot manager is told', () => {
  // A position as the depot view carries it, every private field filled in.
  const position = {
    isin: 'US0000000001', symbol: 'MADE', name: 'Made Up Inc', assetType: 'stock', quantity: 123.45,
    costEur: 87.65, priceEur: 99.01, priceDay: '2026-10-07', valueEur: 12_222.33, weight: 0.1234,
    concentrated: false, gain: 0.1296, openedAt: '2024-03-15', lastTradeAt: '2025-11-02', tradeIds: [41, 42],
    tracked: true, score: 4.1, verdict: 'HOLD', sector: 'Technology',
    reason: { entryId: 7, day: '2024-03-15', headline: 'Meine geheime These' }, thesis: null, flags: [],
  };
  const lists = classifyDepotCheck([], [stock('MADE', 4.1, { verdict: 'HOLD', chart: chart('down'), weight: 0.1234 })], settings);
  const input = managerInput({
    positions: [position], sectors: [{ sector: 'Technology', weight: 1 }],
    charts: new Map([['MADE', chart('down')]]), lists, limits: { maxPosition: 0.15, maxSector: 0.35 },
  });
  const text = JSON.stringify(input);

  it('carries the weight in per cent, the sector and the app\'s own reading', () => {
    assert.equal(input.depot[0].gewichtProzent, 12.3);
    assert.equal(input.depot[0].chart, 'abwärts');
    assert.deepEqual(input.reduzierenAnsehen.map((x) => x.symbol), ['MADE']);
  });

  it('never quantities, prices, values, gains, dates, trades or the journal', () => {
    for (const leak of ['123.45', '87.65', '99.01', '12222', '0.1296', '2024-03-15', '2025-11-02', 'geheime', 'isin', 'US0000000001']) {
      assert.ok(!text.includes(leak), `${leak} reached the prompt`);
    }
  });

  it('is told what the verdict bands are, from the bands themselves', () => {
    assert.match(MANAGER_SYSTEM, /STRONG BUY ab 8,0/);
    assert.match(MANAGER_SYSTEM, /STRONG SELL darunter/);
  });
});
