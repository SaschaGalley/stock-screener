/**
 * Headlines written afterwards for stored bull and bear points: which points
 * get one, and that each lands on its own point and nowhere else.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readCases } from '../src/cases.js';
import { untitledPoints, usableTitle, withTitles } from '../src/case-titles.js';

describe('headlines for stored points', () => {
  it('asks for theses, figures, flat lists and old risks — never for triggers or a paragraph', () => {
    const points = untitledPoints({
      bullCase: { theses: ['Werkzeugbau wächst mit jedem neuen Werk', { title: 'Schon betitelt', text: 'Dieser Punkt hat eine.' }], figures: ['Marge 31 % gegen 18 % der Peers'], triggers: ['Auftragseingang über 2 Mrd.'] },
      bearCase: ['Ein Großkunde steht für 40 % des Umsatzes', 'Der Preiskampf in Asien drückt die Marge'],
      keyRisks: ['Die Lizenz läuft 2028 aus'],
    });
    assert.deepEqual(points.map((p) => p.text), [
      'Werkzeugbau wächst mit jedem neuen Werk',
      'Marge 31 % gegen 18 % der Peers',
      'Ein Großkunde steht für 40 % des Umsatzes',
      'Der Preiskampf in Asien drückt die Marge',
      'Die Lizenz läuft 2028 aus',
    ]);
    assert.deepEqual(untitledPoints({ bullCase: 'Ein Absatz. Noch ein Satz.', bearCase: 'Und hier.' }), []);
  });

  it('puts each headline over its own point and leaves the text as it was', () => {
    const stored = {
      bullCase: { theses: ['Werkzeugbau wächst mit jedem neuen Werk'], figures: ['Marge 31 % gegen 18 % der Peers'], triggers: ['Auftragseingang über 2 Mrd.'] },
      bearCase: ['Ein Großkunde steht für 40 % des Umsatzes'],
      keyRisks: ['Die Lizenz läuft 2028 aus'],
    };
    const points = untitledPoints(stored);
    const out = withTitles(stored, points, ['Jedes Werk bringt Aufträge', 'Marge weit über den Peers', 'Abhängig von einem Kunden', 'Lizenz endet 2028']);

    const c = readCases(out);
    assert.deepEqual(c.bull.theses, [{ title: 'Jedes Werk bringt Aufträge', text: 'Werkzeugbau wächst mit jedem neuen Werk' }]);
    assert.deepEqual(c.bull.figures, [{ title: 'Marge weit über den Peers', text: 'Marge 31 % gegen 18 % der Peers' }]);
    assert.deepEqual(c.bull.triggers, [{ title: null, text: 'Auftragseingang über 2 Mrd.' }]);
    assert.deepEqual(c.bear.unsorted, [
      { title: 'Abhängig von einem Kunden', text: 'Ein Großkunde steht für 40 % des Umsatzes' },
      { title: 'Lizenz endet 2028', text: 'Die Lizenz läuft 2028 aus' },
    ]);
    // The stored original is not touched.
    assert.equal(stored.bearCase[0], 'Ein Großkunde steht für 40 % des Umsatzes');
    // And a second pass has nothing left to ask.
    assert.deepEqual(untitledPoints(out), []);
  });

  it('keeps a point without a headline rather than one that is empty, the point itself, or punctuated', () => {
    assert.equal(usableTitle('', 'Ein Punkt mit Text'), null);
    assert.equal(usableTitle('Ein Punkt mit Text', 'Ein Punkt mit Text'), null);
    assert.equal(usableTitle('„Marge weit über Peers.“', 'Marge 31 % gegen 18 % der Peers, seit drei Jahren'), 'Marge weit über Peers');
    const stored = { bullCase: ['Ein Punkt mit genug Text'], bearCase: [] as string[] };
    const out = withTitles(stored, untitledPoints(stored), [undefined]);
    assert.equal(out.bullCase[0], 'Ein Punkt mit genug Text');
  });
});
