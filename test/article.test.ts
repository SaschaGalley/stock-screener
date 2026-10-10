/** The report on a stock: each section told only its own material, the editor the verdict as it stands. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARTICLE_SECTIONS, articleMarkdown, editorPrompt, sectionPrompt, type StockArticle } from '../src/analysis/article.js';

const ctx = { symbol: 'MADE', company: 'Made Up Inc', price: '412,30 $', date: '2026-10-10' };

describe('the report\'s sections', () => {
  it('give each section its task and its material, and none of the others\'', () => {
    const p = sectionPrompt('valuation', ctx, 'KGV 21 gegen 30 in der Branche');
    assert.match(p, /„Bewertung und Analysten"/);
    assert.match(p, /KGV 21 gegen 30 in der Branche/);
    assert.doesNotMatch(p, /„Der Chart"/);
    assert.match(p, /erfindest du nicht/);
  });

  it('ask for a short, chosen text rather than every figure of the material', () => {
    const p = sectionPrompt('figures', ctx, 'x');
    assert.match(p, /110 bis 180 Wörter/);
    assert.match(p, /Auswählen statt aufzählen/);
    assert.match(p, /Höchstens eine Zahl je Satz/);
    assert.match(p, /du schreibst nicht über das\s+Material/);
  });

  it('say so where a section has no material, rather than leave the model to fill it', () => {
    assert.match(sectionPrompt('chart', ctx, '  '), /Kein Material/);
  });

  it('keep the debate to the arguments', () => {
    assert.match(sectionPrompt('debate', ctx, 'x'), /wiederhole sie nicht/);
    assert.equal(ARTICLE_SECTIONS.length, new Set(ARTICLE_SECTIONS.map((s) => s.key)).size);
  });
});

describe('the editor', () => {
  it('is told the verdict as the arithmetic set it, and every section', () => {
    const p = editorPrompt(ctx, { recommendation: 'HOLD', score: 5.43, thesis: 'Solide, aber teuer.', fairValue: '380 $ – 450 $' },
      [{ title: 'Marge hält', text: 'Die Marge hält.' }, { title: 'Chart dreht', text: 'Der Trend dreht.' }]);
    assert.match(p, /HOLD,\nScore 5,4 von 10/);
    assert.match(p, /380 \$ – 450 \$/);
    assert.match(p, /#### Marge hält\n\nDie Marge hält\./);
    assert.match(p, /#### Chart dreht/);
  });
});

describe('the report as markdown', () => {
  it('runs headline, lead, sections and conclusion in order', () => {
    const a: StockArticle = {
      symbol: 'MADE', generatedAt: '2026-10-10T20:00:00Z',
      basis: { analysisAt: '2026-10-10T19:00:00Z', recommendation: 'HOLD', score: 5.4, chartAsOf: null, briefAt: null },
      headline: 'Made Up hält Kurs', teaser: 'Kurz gesagt.', conclusion: 'Am Ende HOLD.',
      sections: [{ key: 'business', title: 'Das Geschäft', text: 'Text.' }], model: null, costUsd: null,
    };
    assert.equal(articleMarkdown(a), '# Made Up hält Kurs\n\n**Kurz gesagt.**\n\n## Das Geschäft\n\nText.\n\n## Fazit\n\nAm Ende HOLD.');
  });
});
