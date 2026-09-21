/**
 * The research brief's answer, read leniently on shape and strictly on
 * substance.
 *
 * Lenient because models fence their JSON, rename a key to camelCase, or leave
 * a list out; none of that should cost a five-cent call. Strict because the one
 * thing the parser must never do is manufacture evidence: an item without text
 * is dropped, and an evidence label it does not recognise reads as the weakest.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseFindings, renderFindings, salvageTruncatedJson } from '../src/data/perplexity.js';

describe('parsing the brief', () => {
  it('reads a fenced answer and strips the citation markers', () => {
    const f = parseFindings('Here you go:\n```json\n' + JSON.stringify({
      events: [{ date: '2026-07-22', what: 'Guide raised by $15m on a 150bp beat [1][6]', source: 'https://x', independent: true }],
      bear_evidence: [],
      bull_claims: [],
    }) + '\n```');

    assert.ok(f);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].what, 'Guide raised by $15m on a 150bp beat');
  });

  it('treats a missing list as empty and an empty answer as a real one', () => {
    // "Searched and found nothing" is a finding. The old free-text path would
    // have called a short answer a refusal and thrown it away.
    const f = parseFindings('{"events": []}');
    assert.deepEqual(f, { events: [], bearEvidence: [], bullClaims: [] });
  });

  it('drops an item with no text rather than keeping a blank finding', () => {
    const f = parseFindings(JSON.stringify({
      bear_evidence: [{ date: '2026-08-01', what: '   ', independent: true }, { what: 'Seat reductions at two large customers' }],
    }));
    assert.equal(f?.bearEvidence.length, 1);
    assert.equal(f?.bearEvidence[0].independent, false, 'an unlabelled source is not assumed independent');
  });

  it('maps evidence verdicts, and reads anything unrecognised as the weakest', () => {
    const f = parseFindings(JSON.stringify({
      bull_claims: [
        { claim: 'Hyperscalers improve margins', evidence: 'contradicted', detail: 'AI mix is a GM headwind' },
        { claim: 'Federal demand is robust', evidence: 'Independent' },
        { claim: 'Q2 is an inflection', evidence: 'probably true' },
      ],
    }));
    assert.deepEqual(f?.bullClaims.map((c) => c.evidence), ['contradicted', 'independent', 'management-only']);
  });

  it('returns null for text that is not JSON, so the caller can fall back', () => {
    assert.equal(parseFindings('ServiceNow reported strong results this quarter.'), null);
  });
});

describe('rendering the brief', () => {
  it('says an empty section was searched, not skipped', () => {
    const md = renderFindings({ events: [], bearEvidence: [], bullClaims: [] });
    assert.match(md, /Keine spezifischen Gegenbelege gefunden — das ist eine Aussage, keine Lücke/);
  });

  it('labels a contradicted claim so the reader cannot miss it', () => {
    const md = renderFindings({
      events: [], bearEvidence: [],
      bullClaims: [{ claim: 'Hyperscalers improve margins', evidence: 'contradicted', detail: 'AI mix is a headwind', source: null }],
    });
    assert.match(md, /Hyperscalers improve margins\*\* — widerlegt: AI mix is a headwind/);
  });
});

describe('salvaging a truncated answer', () => {
  // The first live run of the new brief ran to 14k characters and was cut off
  // mid-sentence at max_tokens — three containers deep, inside a string.
  const truncated = `{
    "events": [{"date": "2026-07-22", "what": "Guide raised", "independent": true},
               {"date": "2026-08-01", "what": "CFO departs", "independent": true}],
    "bear_evidence": [{"date": "2026-07-22", "what": "Federal revenue pulled forward", "independent": true}],
    "bull_claims": [{"claim": "AI drives growth", "evidence": "independent", "detail": "Reuters reported a stake at a ~$700m`;

  it('keeps every item that finished and drops the one being written', () => {
    const f = parseFindings(truncated);
    assert.ok(f, 'a truncated answer is not a lost answer');
    assert.equal(f.events.length, 2);
    assert.equal(f.bearEvidence.length, 1);
    assert.equal(f.bullClaims.length, 0, 'the half-written claim is not reconstructed');
  });

  it('never invents a closing for text inside a string', () => {
    // A brace inside a string must not count as structure, or the cut lands
    // in the middle of a sentence.
    const out = salvageTruncatedJson('{"events": [{"what": "a {tricky} [value]"}, {"what": "cut');
    assert.ok(out);
    assert.deepEqual(JSON.parse(out), { events: [{ what: 'a {tricky} [value]' }] });
  });

  it('gives up when not one element completed', () => {
    assert.equal(salvageTruncatedJson('{"events": [{"what": "never fin'), null);
  });

  it('passes a complete document through untouched', () => {
    const whole = '{"events": []}';
    assert.equal(salvageTruncatedJson(whole), whole);
  });
});
