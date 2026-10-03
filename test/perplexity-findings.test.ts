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
    assert.deepEqual(f, {
      debate: [], events: [], kpis: [], bearEvidence: [], bullClaims: [], bearClaims: [], catalysts: [],
    });
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

  it('grades a bear claim on its own scale, with opinion as the weakest', () => {
    // "management-only" means nothing for a short seller's thesis; an
    // unrecognised label must not borrow it, nor upgrade the claim.
    const f = parseFindings(JSON.stringify({
      bear_claims: [
        { claim: 'Hyperscaler agents erode seat counts', evidence: 'opinion' },
        { claim: 'Deal velocity is slowing', evidence: 'independent', detail: 'Two large renewals shrank' },
        { claim: 'Federal demand is collapsing', evidence: 'Contradicted' },
        { claim: 'The multiple prices perfection', evidence: 'widely held' },
      ],
    }));
    assert.deepEqual(f?.bearClaims?.map((c) => c.evidence), ['opinion', 'independent', 'contradicted', 'opinion']);
  });

  it('reads the answer after the thinking, not a brace inside it', () => {
    // sonar-reasoning-pro writes its reasoning first, and the reasoning quotes
    // the JSON shape it is about to fill.
    const f = parseFindings('<think>The schema is {"events": [...]}. Let me check ```json drafts```.</think>\n'
      + JSON.stringify({ events: [{ date: '2026-07-22', what: 'Guide raised', impact: '+1% revenue' }] }));
    assert.equal(f?.events[0].impact, '+1% revenue');
  });

  it('keeps a KPI only with values, and drops the periods the model could not fill', () => {
    const f = parseFindings(JSON.stringify({
      kpis: [
        { name: 'cRPO', values: [
          { period: 'Q2 2026', value: '$13.2bn, +21%' },
          { period: 'Q1 2026', value: 'Not available in the gathered independent sources' },
          { period: 'Q4 2025', value: 'Baseline not disclosed in the gathered sources' },
          { period: 'Q3 2025', value: '$12.1bn, not disclosed by segment' },
        ], read: 'Steady' },
        { name: 'NRR', values: [{ period: 'Q2 2026', value: 'Not disclosed' }] },
      ],
    }));
    assert.deepEqual(f?.kpis?.map((k) => [k.name, k.values.length]), [['cRPO', 2]], 'a figure with a caveat is still a figure');
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

  it('reports missing bear claims as none found, but only when they were asked for', () => {
    const asked = renderFindings({ events: [], bearEvidence: [], bullClaims: [], bearClaims: [] });
    assert.match(asked, /Keine Bären-Thesen im Umlauf gefunden/);
    // A row from before the question existed did not search and must not say it did.
    const old = renderFindings({ events: [], bearEvidence: [], bullClaims: [] });
    assert.doesNotMatch(old, /Bären-Thesen/);
  });

  it('labels a contradicted claim so the reader cannot miss it', () => {
    const md = renderFindings({
      events: [], bearEvidence: [],
      bullClaims: [{ claim: 'Hyperscalers improve margins', evidence: 'contradicted', detail: 'AI mix is a headwind', source: null }],
    });
    assert.match(md, /Hyperscalers improve margins\*\* — widerlegt: AI mix is a headwind/);
  });
});

describe('rendering the argued claims', () => {
  it('sets out the argument beneath the claim', () => {
    const md = renderFindings({
      events: [], bearEvidence: [],
      bullClaims: [{
        claim: 'AI adds wallet share', mechanism: 'Agents add departments', stake: '$1bn ACV',
        proponents: 'Morgan Stanley', evidence: 'independent', detail: 'Checks confirm',
        counter: 'Q3 guide decelerates', settles: 'Q3 cRPO on 2026-10-28', source: null,
      }],
    });
    assert.match(md, /\*\*AI adds wallet share\*\* \(Morgan Stanley\) — unabhängig belegt\n  - _Wirkung:_ Agents add departments/);
    assert.match(md, /_Dagegen:_ Q3 guide decelerates/);
  });

  it('shows the sections a new brief asked for, and none an old one did not', () => {
    const md = renderFindings({ debate: [], events: [], kpis: [], bearEvidence: [], bullClaims: [], catalysts: [] });
    assert.match(md, /Kerndebatte/);
    assert.match(md, /Termine/);
    assert.doesNotMatch(renderFindings({ events: [], bearEvidence: [], bullClaims: [] }), /Kerndebatte|Termine|Kennzahlen/);
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
