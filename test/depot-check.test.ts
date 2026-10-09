/**
 * The depot check on made-up stocks and a made-up depot: who is a candidate,
 * where each lands once analysed, and what of the depot the model is told.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyDepotCheck, managerInput, MANAGER_SYSTEM, selectCandidates, shareWords, stepSize,
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
  // Positions as the depot view carries them, every private field filled in.
  const position = {
    isin: 'US0000000001', symbol: 'MADE', name: 'Made Up Inc', assetType: 'stock', quantity: 123.45,
    costEur: 87.65, priceEur: 99.01, priceDay: '2026-10-07', valueEur: 12_222.33, weight: 0.1234,
    concentrated: false, gain: 0.1296, openedAt: '2024-03-15', lastTradeAt: '2025-11-02', tradeIds: [41, 42],
    tracked: true, score: 4.1, verdict: 'HOLD', sector: 'Technology',
    reason: { entryId: 7, day: '2024-03-15', headline: 'Meine geheime These' }, flags: [],
    thesis: { contradicted: 1, total: 3, at: '2026-09-20T18:00:00.000Z' },
    viaFunds: 0.0123, scoreBefore: { score: 5.3, at: '2026-09-10T22:00:00.000Z' },
    upcoming: [{ day: '2026-10-28', kind: 'earnings', title: 'Nächste Quartalszahlen', detail: null }],
  };
  const fund = {
    ...position, isin: 'IE0000000002', symbol: 'FUND', name: 'Made Up World ETF', assetType: 'etf',
    quantity: 321.5, valueEur: 45_678.9, weight: 0.4567, gain: 0.3141, sector: null, score: null, verdict: null,
    viaFunds: null, scoreBefore: null, upcoming: [],
  };
  const protection = {
    asOf: '2026-10-07', close: 214.37, currency: 'USD', dailyMove: 0.0213, rsi: 71.6, overSma200: 0.183, channel: 'oben' as const,
    stop: { price: 198.11, distance: -0.0758, basis: 'support' as const, level: 201.5 },
    trailing: { price: 203.25, high: 222.9, width: 0.0882, distance: -0.0519 }, resistance: 0.04,
  };
  const held = stock('MADE', 4.1, { verdict: 'HOLD', chart: chart('down'), weight: 0.1234, gain: 0.1296, protection });
  const lists = classifyDepotCheck([], [held], settings);
  const input = managerInput({
    positions: [position, fund], sectors: [{ sector: 'Technology', weight: 1 }],
    holdings: new Map([['MADE', held]]), lists, limits: { maxPosition: 0.15, maxSector: 0.35 },
    market: null, sectorTrends: [], cashShare: 0.0825, today: '2026-10-08',
    notes: new Map([['MADE', 'Starker Support bei 200 $, Stop eher bei 197 $.']]),
    trades: new Map([
      ['MADE', [
        { id: 42, day: '2026-09-24', kind: 'sell', quantity: 60.25, price: 95.5, currency: 'EUR' },
        { id: 41, day: '2024-03-15', kind: 'buy', quantity: 150.5, price: 80, currency: 'EUR' },
      ]],
      ['FUND', [{ id: 43, day: '2025-01-10', kind: 'buy', quantity: 321.5, price: 77.77, currency: 'EUR' }]],
    ]),
    reasons: new Map([['MADE', [{ day: '2026-09-24', kind: 'sell' as const, body: 'Teilverkauf nach dem Lauf, der Rest läuft weiter.' }]]]),
    previous: {
      at: '2026-09-29T10:00:00.000Z',
      moves: [{ action: 'reduzieren' as const, symbol: 'MADE', protect: 'stop' as const, targetPct: 8, stopPrice: null, reason: 'Klumpen abbauen.' }],
    },
  });
  const text = JSON.stringify(input);

  it('carries a stock\'s weight and gain in per cent, its sector and the app\'s own reading', () => {
    const made = input.depot[0] as Extract<(typeof input.depot)[number], { seitKaufProzent: unknown }>;
    assert.equal(made.gewichtProzent, 12.3);
    assert.equal(made.seitKaufProzent, 13);
    assert.equal(made.chart?.trend, 'abwärts');
    assert.equal(made.technik?.stopProzent, -7.6);
    assert.equal(made.technik?.trailingProzent, 8.8);
    assert.equal(made.technik?.rsi, 72);
    assert.equal(made.ueberFondsProzent, 1.2);
    assert.equal(made.scoreVor4Wochen, 5.3);
    assert.deepEqual(made.termine, [{ datum: '2026-10-28', was: 'Nächste Quartalszahlen' }]);
  });

  it('carries the owner\'s note as he wrote it, and the close the note can be read against', () => {
    const made = input.depot[0] as Extract<(typeof input.depot)[number], { seitKaufProzent: unknown }>;
    assert.equal(made.notizDesAnlegers, 'Starker Support bei 200 $, Stop eher bei 197 $.');
    assert.equal(made.technik?.kurs, 214.37);
    assert.equal(made.technik?.waehrung, 'USD');
  });

  it('carries the months held, the thesis check\'s counts and the cash as a share, as the owner allowed', () => {
    const made = input.depot[0] as Extract<(typeof input.depot)[number], { seitKaufProzent: unknown }>;
    assert.equal(made.gehaltenMonate, 30);
    assert.deepEqual(made.thesenCheck, { widerlegt: 1, gesamt: 3, vorTagen: 17 });
    assert.equal(input.liquiditaetProzent, 8.3);
  });

  it('carries a stock\'s trades by day, price and size against the position, and the reasons he wrote, as he allowed', () => {
    const made = input.depot[0] as Extract<(typeof input.depot)[number], { seitKaufProzent: unknown }>;
    assert.deepEqual(made.transaktionen, [
      { datum: '2026-09-24', vorTagen: 14, art: 'Verkauf', kurs: 95.5, waehrung: 'EUR', umfang: '40 % der Position verkauft', kursSeitdemProzent: 3.7 },
      { datum: '2024-03-15', vorTagen: 937, art: 'Kauf', kurs: 80, waehrung: 'EUR', umfang: 'Position eröffnet', kursSeitdemProzent: 23.8 },
    ]);
    assert.deepEqual(made.begruendungen, [{ datum: '2026-09-24', zu: 'Verkauf', text: 'Teilverkauf nach dem Lauf, der Rest läuft weiter.' }]);
  });

  it('carries its own last step on the stock, to read against what was done since', () => {
    const made = input.depot[0] as Extract<(typeof input.depot)[number], { seitKaufProzent: unknown }>;
    assert.deepEqual(made.letzterVorschlag, {
      datum: '2026-09-29', vorTagen: 9, schritt: 'reduzieren', zielGewichtProzent: 8, schutz: 'stop', stopKurs: null, warum: 'Klumpen abbauen.',
    });
  });

  it('carries a fund by name, kind and weight alone', () => {
    assert.deepEqual(input.depot[1], { name: 'Made Up World ETF', symbol: 'FUND', art: 'etf', gewichtProzent: 45.7 });
  });

  it('never quantities, average cost, values, a fund\'s gain or trades, the journal\'s other words, or the computed stops', () => {
    for (const leak of [
      '123.45', '321.5', '150.5', '60.25', '87.65', '99.01', '12222', '45678', '0.1296', '31.4', '77.77', '2025-01-10',
      '2025-11-02', 'geheime', 'isin', 'US0000000001', '198.11', '203.25', '222.9', '201.5', '2026-09-10', '2026-09-20',
    ]) {
      assert.ok(!text.includes(leak), `${leak} reached the prompt`);
    }
  });

  it('is told what the verdict bands are, from the bands themselves', () => {
    assert.match(MANAGER_SYSTEM, /STRONG BUY ab 8,0/);
    assert.match(MANAGER_SYSTEM, /STRONG SELL darunter/);
  });
});

describe('a step\'s size', () => {
  const now = { quantity: 15, valueEur: 2_580 };

  it('turns a lower target into the share of the position to sell, in today\'s shares and euros', () => {
    const s = stepSize(0.8, 0.016, now, 160_000);
    assert.equal(s?.kind, 'sell');
    if (s?.kind !== 'sell') return;
    assert.ok(Math.abs(s.fraction - 0.5) < 1e-9);
    assert.ok(Math.abs(s.shares! - 7.5) < 1e-9);
    assert.ok(Math.abs(s.euros! - 1_290) < 1e-9);
    assert.equal(stepSize(0, 0.016, now, 160_000)?.kind, 'sell');
  });

  it('turns a higher target into euros at today\'s depot value, and shares at today\'s price', () => {
    const s = stepSize(2.5, 0.016, now, 100_000);
    assert.equal(s?.kind, 'buy');
    if (s?.kind !== 'buy') return;
    assert.ok(Math.abs(s.euros - 900) < 1e-9);
    assert.ok(Math.abs(s.shares! - 900 / 172) < 1e-9);
    assert.equal(stepSize(2, null, null, 100_000)?.kind, 'buy');
    assert.equal(stepSize(null, 0.016, now, 100_000), null);
  });

  it('says a share in words where one fits', () => {
    assert.equal(shareWords(0.5), 'die Hälfte');
    assert.equal(shareWords(0.36), 'gut ein Drittel');
    assert.equal(shareWords(0.3), 'knapp ein Drittel');
    assert.equal(shareWords(0.42), '42 %');
    assert.equal(shareWords(1), 'alles');
  });
});
