/**
 * The bull and bear case, read from whichever shape it was stored in.
 *
 * Three shapes are in the database and all of them are history worth showing:
 * a paragraph (schema v3), a flat list with a separate ↑/↓ watch list (until
 * 2 October 2026), and sections. Every reader goes through `readCases`, so this
 * is where a shape it cannot read would first show.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseLines, readCases, type CasePointView } from '../src/cases.js';

const plain = (...texts: string[]): CasePointView[] => texts.map((text) => ({ title: null, text }));

describe('reading the stored case', () => {
  it('takes today\'s sections as they are', () => {
    const c = readCases({
      bullCase: { theses: ['Platform lock-in widens spend per customer'], figures: ['ROIC 28% vs WACC 10%'], triggers: ['Q3 cRPO above 21%'] },
      bearCase: { theses: ['AI agents erode seats'], figures: ['Conservative fair value 57% below price'], triggers: [] },
    });
    assert.deepEqual(c.bull.theses, plain('Platform lock-in widens spend per customer'));
    assert.deepEqual(c.bear.figures, plain('Conservative fair value 57% below price'));
    assert.deepEqual(c.bull.unsorted, []);
    assert.deepEqual(c.undirected, []);
  });

  it('keeps a flat list unsorted rather than guessing a section for it', () => {
    const c = readCases({ bullCase: ['ROIC 64%', 'Guide raised'], bearCase: ['P/E 39x'], keyRisks: ['Antitrust ruling'] });
    assert.deepEqual(c.bull.unsorted, plain('ROIC 64%', 'Guide raised'));
    assert.deepEqual(c.bull.theses, []);
    assert.deepEqual(c.bear.unsorted, plain('P/E 39x', 'Antitrust ruling'), 'old risks read as bear points');
  });

  it('moves each legacy trigger to the side its arrow points to, without the arrow', () => {
    const c = readCases({
      bullCase: [], bearCase: [],
      watch: ['↑ wenn Umsatzwachstum >9% yoy', '↓ Wenn Regulatoren eingreifen', 'Kurs kreuzt die 200-Tage-Linie'],
    });
    assert.deepEqual(c.bull.triggers, plain('Umsatzwachstum >9% yoy'));
    assert.deepEqual(c.bear.triggers, plain('Regulatoren eingreifen'));
    assert.deepEqual(c.undirected, ['Kurs kreuzt die 200-Tage-Linie'], 'no arrow, no guessed direction');
  });

  it('keeps a headline beside its text, and drops one that says nothing the text does not', () => {
    const c = readCases({
      bullCase: {
        theses: [{ title: 'Lock-in widens spend', text: 'Every new workflow raises spend per customer.' }, 'An old point without one'],
        figures: [{ title: '  ', text: 'ROIC 28% vs WACC 10%' }, { title: 'Same', text: 'Same' }],
        triggers: [],
      },
      bearCase: [],
    });
    assert.deepEqual(c.bull.theses, [
      { title: 'Lock-in widens spend', text: 'Every new workflow raises spend per customer.' },
      { title: null, text: 'An old point without one' },
    ]);
    assert.deepEqual(c.bull.figures, plain('ROIC 28% vs WACC 10%', 'Same'));
  });

  it('splits a schema-v3 paragraph into its sentences', () => {
    const c = readCases({ bullCase: 'Margins expanded for six quarters. Buybacks shrink the share count steadily.', bearCase: '' });
    assert.equal(c.bull.unsorted.length, 2);
    assert.deepEqual(c.bear.unsorted, []);
  });
});

describe('the case as text', () => {
  it('labels each section by direction and skips the empty ones', () => {
    const c = readCases({
      bullCase: { theses: ['A'], figures: [], triggers: ['B'] },
      bearCase: { theses: ['C'], figures: ['D'], triggers: ['E'] },
    });
    const fmt = { bullet: '- ', heading: (l: string) => `${l}:` };
    assert.deepEqual(caseLines(c.bull, 'bull', fmt), ['Thesen:', '- A', '', 'Hebt das Urteil, wenn:', '- B']);
    assert.ok(caseLines(c.bear, 'bear', fmt).includes('Senkt das Urteil, wenn:'));
    const titled = readCases({ bullCase: { theses: [{ title: 'Lock-in', text: 'Spend per customer grows.' }], figures: [], triggers: [] }, bearCase: [] });
    assert.deepEqual(caseLines(titled.bull, 'bull', fmt), ['Thesen:', '- Lock-in: Spend per customer grows.']);
  });
});
