/**
 * Research pasted back by hand, kind by kind: read leniently on shape, strict
 * on what it may claim — an unknown verdict never upgrades a thesis, an
 * unknown position is "unclear" — and a stray sentence is not a report.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pasteResearch, RESEARCH_PARSERS, ResearchInputError } from '../src/research/research.js';

const fence = (o: unknown) => 'Here is the research:\n```json\n' + JSON.stringify(o) + '\n```';
const preview = (kind: 'company' | 'earnings' | 'thesis' | 'theme' | 'review', body: string) =>
  pasteResearch({ kind, symbols: ['XYZ'], question: 'Who wins?', text: body, tool: 'Perplexity', save: false });

describe('a preview of the next report', () => {
  it('reads the bar, the thresholds and the history', async () => {
    const answer = {
      report_date: '2026-10-28', bar: 'cRPO above 21% [3]', implied_move: '±9%',
      consensus: [{ metric: 'Revenue', value: '$3.9B', source: 'https://a.example/c' }],
      history: [{ period: 'Q2 2026', result: 'beat, guide +$15M', reaction: '-3%' }],
      watch: [{ item: 'cRPO', why: 'seat erosion', bull_if: '≥21%', bear_if: '<20%' }],
      risks: [{ risk: 'federal timing', source: 'https://a.example/r' }, { risk: '' }],
    };
    const d = RESEARCH_PARSERS.earnings(answer);
    assert.equal(d.bar, 'cRPO above 21%');
    assert.deepEqual(d.watch[0], { item: 'cRPO', why: 'seat erosion', bullIf: '≥21%', bearIf: '<20%' });
    assert.equal(d.risks.length, 1);
    const r = await preview('earnings', fence(answer));
    assert.deepEqual(r.summary, {
      structured: true, found: ['1 Konsens-Zahl', '1 frühere Meldung', '1 Prüfpunkt', '1 Risiko'], sources: 2,
    });
  });
});

describe('a check of my own theses', () => {
  it('never upgrades a verdict it does not know, and reads a single source as a list', () => {
    const d = RESEARCH_PARSERS.thesis({
      theses: [
        { thesis: 'They win the AI race', verdict: 'Mostly true', against: 'a', for: 'b', source: 'https://x.example' },
        { thesis: 'Cheap on FCF', verdict: 'CONTRADICTED', against: 'c', for: 'd', sources: ['https://y.example', 'n/a'] },
      ],
      missed: [{ point: 'Share count rising' }],
    });
    assert.deepEqual(d.theses.map((t) => t.verdict), ['untestable', 'contradicted']);
    assert.deepEqual(d.theses[0].sources, ['https://x.example']);
    assert.deepEqual(d.theses[1].sources, ['https://y.example']);
    assert.equal(d.missed.length, 1);
  });
});

describe('a question across several stocks', () => {
  it('reads each company with a known position or "unclear"', () => {
    const d = RESEARCH_PARSERS.theme({
      answer: 'Too early to say.',
      companies: [{ ticker: 'googl', position: 'leader' }, { ticker: 'msft', position: 'winning' }, { position: 'x' }],
    });
    assert.deepEqual(d.companies.map((c) => [c.ticker, c.position]), [['GOOGL', 'leader'], ['MSFT', 'unclear']]);
  });
});

describe('a look back on one decision', () => {
  it('never passes a reason on a grade it does not know, and keeps what happened', async () => {
    const answer = {
      verdict: 'mostly held', cause: 'OTHER', reason_check: 'The AI thesis played out [2].', drivers: 'Rates fell.',
      lesson: 'Size a hype purchase smaller.', now: 'Still applies.',
      what_happened: [{ date: '2026-07-22', event: 'Q2 beat', effect: '+8% on the day', source: 'https://a.example/q2' }, { event: '' }],
    };
    const d = RESEARCH_PARSERS.review(answer);
    assert.equal(d.verdict, 'too_early');
    assert.equal(d.cause, 'other');
    assert.equal(d.reasonCheck, 'The AI thesis played out.');
    assert.equal(d.whatHappened.length, 1);
    const r = await preview('review', fence(answer));
    assert.deepEqual(r.summary, { structured: true, found: ['1 Prüfung der Begründung', '1 Ereignis', '1 Lehre'], sources: 1 });
  });
});

describe('pasting', () => {
  it('keeps a written report as prose and refuses a stray sentence', async () => {
    const r = await preview('theme', 'The race is open. '.repeat(40));
    assert.equal(r.summary.structured, false);
    await assert.rejects(preview('earnings', 'ok, done'), ResearchInputError);
  });

  it('counts the company brief in words', async () => {
    const r = await preview('company', fence({
      events: [{ date: '2026-07-22', what: 'Q2 beat', source: 'https://a.example', independent: false }],
      bull_claims: [{ claim: 'Upgrades outrun seat loss', evidence: 'independent', detail: 'd' }],
    }));
    assert.deepEqual(r.summary.found, ['1 Ereignis', '1 Bullen-These']);
  });
});
