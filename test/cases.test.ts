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

import { caseLines, readCases } from '../src/cases.js';

describe('reading the stored case', () => {
  it('takes today\'s sections as they are', () => {
    const c = readCases({
      bullCase: { theses: ['Platform lock-in widens spend per customer'], figures: ['ROIC 28% vs WACC 10%'], triggers: ['Q3 cRPO above 21%'] },
      bearCase: { theses: ['AI agents erode seats'], figures: ['Conservative fair value 57% below price'], triggers: [] },
    });
    assert.deepEqual(c.bull.theses, ['Platform lock-in widens spend per customer']);
    assert.deepEqual(c.bear.figures, ['Conservative fair value 57% below price']);
    assert.deepEqual(c.bull.unsorted, []);
    assert.deepEqual(c.undirected, []);
  });

  it('keeps a flat list unsorted rather than guessing a section for it', () => {
    const c = readCases({ bullCase: ['ROIC 64%', 'Guide raised'], bearCase: ['P/E 39x'], keyRisks: ['Antitrust ruling'] });
    assert.deepEqual(c.bull.unsorted, ['ROIC 64%', 'Guide raised']);
    assert.deepEqual(c.bull.theses, []);
    assert.deepEqual(c.bear.unsorted, ['P/E 39x', 'Antitrust ruling'], 'old risks read as bear points');
  });

  it('moves each legacy trigger to the side its arrow points to, without the arrow', () => {
    const c = readCases({
      bullCase: [], bearCase: [],
      watch: ['↑ wenn Umsatzwachstum >9% yoy', '↓ Wenn Regulatoren eingreifen', 'Kurs kreuzt die 200-Tage-Linie'],
    });
    assert.deepEqual(c.bull.triggers, ['Umsatzwachstum >9% yoy']);
    assert.deepEqual(c.bear.triggers, ['Regulatoren eingreifen']);
    assert.deepEqual(c.undirected, ['Kurs kreuzt die 200-Tage-Linie'], 'no arrow, no guessed direction');
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
  });
});
