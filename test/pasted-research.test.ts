/**
 * A deep research report run in a chat app and pasted back by hand.
 *
 * The JSON the brief asks for is read like the API's answer; a tool that wrote
 * a report instead is kept as prose; an empty skeleton or a refusal is not
 * kept at all. The sources are the URLs the items name.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { manualResearchPrompt, pastedResearch } from '../src/data/perplexity.js';

const answer = {
  debate: [{ question: 'Do agents shrink seats faster than AI pricing replaces them?', why: 'w', settles: 's', when: '2026-10-28' }],
  events: [{ date: '2026-07-22', what: 'Q2 beat, guide +$15M', impact: 'i', source: 'https://a.example/q2', independent: false }],
  bear_evidence: [{ date: '2026-07-06', what: 'Gartner: 20% of spend diverted', impact: 'i', source: 'https://b.example/g', independent: true }],
  bull_claims: [{ claim: 'Upgrades outrun seat loss', evidence: 'independent', detail: 'd', source: 'https://a.example/q2' }],
  bear_claims: [],
  catalysts: [{ date: '2026-10-28', event: 'Q3', watch: 'cRPO' }],
};

describe('a report pasted by hand', () => {
  it('reads the JSON inside a fence and lists each source once', () => {
    const r = pastedResearch('Hier:\n```\n' + JSON.stringify(answer) + '\n```', 'Perplexity')!;
    assert.equal(r.summary.structured, true);
    assert.deepEqual(r.summary.counts, { debate: 1, events: 1, kpis: 0, bearEvidence: 1, bullClaims: 1, bearClaims: 0, catalysts: 1 });
    assert.deepEqual(r.context.citations, ['https://a.example/q2', 'https://b.example/g']);
    assert.equal(r.context.model, 'sonar-deep-research');
    assert.equal(r.context.pastedFrom, 'Perplexity');
    assert.match(r.context.synthesis, /Gartner/);
  });

  it('keeps a written report as prose, with the links it contains', () => {
    const prose = '## ServiceNow\n\nThe debate is whether agents shrink fulfiller seats [1]. '.repeat(6)
      + 'See https://a.example/report for the Cantor note.';
    const r = pastedResearch(prose, 'ChatGPT')!;
    assert.equal(r.summary.structured, false);
    assert.equal(r.context.findings, undefined);
    assert.doesNotMatch(r.context.synthesis, /\[1\]/);
    assert.deepEqual(r.context.citations, ['https://a.example/report']);
  });

  it('keeps nothing from an empty skeleton, a stray sentence or a refusal', () => {
    assert.equal(pastedResearch('```json\n{"events": [], "bull_claims": []}\n```', 'Perplexity'), null);
    assert.equal(pastedResearch('ok', 'Perplexity'), null);
    assert.equal(pastedResearch(
      'I cannot provide investment research. I am unable to construct this. I suggest consulting Bloomberg. '.repeat(3),
      'Claude',
    ), null);
  });
});

describe('the brief to copy', () => {
  it('leads with the system prompt and asks for URLs, not citation numbers', () => {
    const p = manualResearchPrompt('ENR.DE', 'Siemens Energy AG');
    assert.match(p, /^You are a senior buy-side equity analyst/);
    assert.match(p, /Research Siemens Energy AG \(ENR\) as of \d{4}-\d{2}-\d{2}\./);
    assert.match(p, /full URL into every "source" field/);
  });
});
