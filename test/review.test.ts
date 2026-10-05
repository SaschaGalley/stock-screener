/**
 * Looking back on decisions, on made-up ones: a journal entry and the trades
 * it explains are one decision, dated by the trade; a sale is right when the
 * stock lagged afterwards; a group too small to compare says so.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decisionsFrom, reviewOutcome, reviewPatterns, stanceOf, type ReviewedDecision,
} from '../src/analysis/review.js';
import type { Trade } from '../src/journal.js';

const trade = (id: number, day: string, isin: string, symbol: string | null, kind: Trade['kind']): Trade => ({
  id, day, isin, symbol, name: `${symbol ?? isin} Corp`, assetType: 'stock', kind, quantity: 1, price: 10, currency: 'EUR',
});
const entry = (id: number, day: string, kind: 'buy' | 'sell' | 'note', symbols: string[], tradeIds: number[] = []) =>
  ({ id, day, kind, symbols, body: `reason ${id}\nmore`, tradeIds });
const head = (b: string) => b.split('\n')[0];

describe('decisions from the journal and the depot', () => {
  const ds = decisionsFrom(
    [
      entry(1, '2026-03-01', 'buy', ['AAA'], [10]),       // linked to the tranche on the 2nd
      entry(2, '2026-04-01', 'buy', ['BBB']),             // a day before its trade
      entry(3, '2026-05-01', 'sell', ['CCC']),            // no trade at all
      entry(4, '2026-05-02', 'note', ['AAA']),
    ],
    [
      trade(10, '2026-03-02', 'X1', 'AAA', 'buy'), trade(11, '2026-03-02', 'X1', 'AAA', 'buy'),
      trade(12, '2026-04-02', 'X2', 'BBB', 'buy'),
      trade(13, '2026-06-01', 'X3', null, 'sell'),
      trade(14, '2026-06-01', 'X4', 'ETF', 'savings-plan'),
    ],
    head,
  );

  it('joins an entry with its trades, dated by the trade, and keeps the rest apart', () => {
    assert.deepEqual(ds.map((d) => [d.day, d.side, d.symbol, d.source, d.tradeIds.length, d.reason]), [
      ['2026-06-01', 'sell', null, 'trade', 1, null],
      ['2026-05-01', 'sell', 'CCC', 'journal', 0, 'reason 3'],
      ['2026-04-02', 'buy', 'BBB', 'both', 1, 'reason 2'],
      ['2026-03-02', 'buy', 'AAA', 'both', 2, 'reason 1'],
    ]);
  });

  it('reads the model as with, against or neutral to the decision', () => {
    assert.equal(stanceOf('buy', 'STRONG BUY'), 'with');
    assert.equal(stanceOf('buy', 'SELL'), 'against');
    assert.equal(stanceOf('sell', 'BUY'), 'against');
    assert.equal(stanceOf('sell', 'HOLD'), 'neutral');
    assert.equal(stanceOf('buy', null), 'none');
  });
});

describe('outcomes and patterns', () => {
  it('dates the horizons not yet reached by the day they will be measured to', () => {
    const o = reviewOutcome('2026-08-31', {
      day: '2026-08-31', verdict: 'BUY', from: null, score: null, price: 1, until: null,
      held: { stock: 0.1, index: 0.05, excess: 0.05 }, horizons: { 1: { stock: 0.02, index: 0.01, excess: 0.01 } },
    })!;
    // As the verdict record counts months: past the 31st runs into the next month.
    assert.deepEqual(o.due, { 3: '2026-12-01', 6: '2027-03-03', 12: '2027-08-31' });
  });

  const decided = (side: 'buy' | 'sell', excess6: number, impulse: boolean, stance: ReviewedDecision['situation'] extends infer S ? S extends { stance: infer T } ? T : never : never): ReviewedDecision => ({
    key: `${side}${excess6}${impulse}${Math.random()}`, day: '2026-01-02', side, symbol: 'AAA', name: null, source: 'trade',
    entryId: null, reason: impulse ? null : 'why', tradeIds: [],
    outcome: { horizons: { 6: { stock: excess6, index: 0, excess: excess6 } }, since: null, due: {} },
    situation: { flags: [], impulse, verdict: null, score: null, stance },
  });

  it('compares purchases after a jump with the rest once both have enough', () => {
    const ds = [
      ...[-0.10, -0.05, -0.02, 0.01, -0.08].map((x) => decided('buy', x, true, 'against')),
      ...[0.03, 0.06, -0.01, 0.02, 0.04, 0.05].map((x) => decided('buy', x, false, 'with')),
      ...[0.04, 0.10, -0.02, 0.06, 0.01].map((x) => decided('sell', x, false, 'neutral')),
    ];
    const { rows, notes } = reviewPatterns(ds);
    const jump = rows.find((r) => r.label.startsWith('Käufe nach'))!.cells[6];
    assert.deepEqual({ n: jump.n, median: jump.median, right: jump.right }, { n: 5, median: -0.05, right: 0.2 });
    assert.equal(rows.find((r) => r.label === 'Alle Verkäufe')!.cells[6].right, 0.2);
    assert.match(notes[0], /Käufe nach einem Lauf, Sprung oder Volumenschub lagen nach 6 Monaten im Median −5,0 %.*\(5 Käufe\), die übrigen \+3,5 % \(6\)/);
    assert.ok(notes.some((n) => n.startsWith('Käufe gegen das Modell-Urteil')));
    assert.ok(notes.some((n) => /Nach deinen Verkäufen.*\+4,0 %.*gehalten wäre im Schnitt besser gewesen/.test(n)));
  });

  it('says when nothing can be compared yet', () => {
    const { notes } = reviewPatterns([decided('buy', 0.1, true, 'with')]);
    assert.deepEqual(notes, ['Noch zu wenige Entscheidungen mit genug Abstand für einen Vergleich: jede Gruppe braucht mindestens 5.']);
  });
});
