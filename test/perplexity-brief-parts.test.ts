/** The research brief asked in two parts, the facts and the debate, and merged — with made-up answers. */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  fetchPerplexity, PART_PROMPT_HASH, PERPLEXITY_PROMPT_HASH, researchPrompt, reusableDebate, WHOLE_PROMPT_HASH,
  type PerplexityContext,
} from '../src/data/perplexity.js';

const asks = (user: string) => [...user.matchAll(/^\d+\. ((?:"[a-z_]+"(?: and )?)+):/gm)]
  .flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));

describe('the brief in two parts', () => {
  const facts = researchPrompt('MADE.DE', 'Made Up AG', 'facts').user;
  const debate = researchPrompt('MADE.DE', 'Made Up AG', 'debate').user;
  const whole = researchPrompt('MADE.DE', 'Made Up AG').user;

  it('asks each list in exactly one part, and all of them in the whole brief', () => {
    assert.deepEqual(asks(facts), ['events', 'kpis', 'bear_evidence', 'catalysts']);
    assert.deepEqual(asks(debate), ['debate', 'bull_claims', 'bear_claims']);
    assert.deepEqual(asks(whole), ['debate', 'events', 'kpis', 'bear_evidence', 'bull_claims', 'bear_claims', 'catalysts']);
    assert.match(facts, /"origin"/);
    assert.doesNotMatch(debate, /Source rule/);
  });

  it('leaves out what the app already holds or never reads', () => {
    assert.doesNotMatch(whole, /"settles": "\.\.\.", "source"/, 'a claim no longer says what settles it');
    assert.match(facts, /No earnings or dividend dates/);
    assert.match(whole, /its earnings and dividend dates\. Do NOT repeat those/);
    assert.match(whole, /At most 2 debate, 5 events, 3 kpis, 4 bear_evidence, 4 bull_claims, 4 bear_claims, 3 catalysts/);
  });

  it('tells the prompts apart by their hashes', () => {
    assert.equal(new Set([PART_PROMPT_HASH.facts, PART_PROMPT_HASH.debate, PERPLEXITY_PROMPT_HASH, WHOLE_PROMPT_HASH]).size, 4);
  });
});

describe('a debate kept from the brief before', () => {
  const day = 86_400_000;
  const now = Date.parse('2026-10-11T00:00:00Z');
  const stored = (debateDaysAgo: number, hash = PART_PROMPT_HASH.debate): PerplexityContext => ({
    model: 'sonar-pro', synthesis: '', citations: [], fetchedAt: '2026-10-01T00:00:00Z',
    findings: {
      debate: [{ question: 'Will made-up seats hold?', why: 'w', settles: null, when: null }],
      events: [], bearEvidence: [], bullClaims: [], bearClaims: [],
    },
    parts: {
      facts: { fetchedAt: '2026-10-01T00:00:00Z', promptHash: PART_PROMPT_HASH.facts, citations: [], raw: '{}' },
      debate: { fetchedAt: new Date(now - debateDaysAgo * day).toISOString(), promptHash: hash, citations: ['https://example.com/a'], raw: '{}' },
    },
  });

  it('stands in while it is young, from the same prompt and model', () => {
    const kept = reusableDebate(stored(20), 'sonar-pro', 30 * day, now);
    assert.equal(kept?.findings.debate?.[0].question, 'Will made-up seats hold?');
    assert.deepEqual(kept?.meta.citations, ['https://example.com/a']);
  });

  it('is asked anew when old, from another prompt or model, or asked whole', () => {
    assert.equal(reusableDebate(stored(31), 'sonar-pro', 30 * day, now), null);
    assert.equal(reusableDebate(stored(5, 'other'), 'sonar-pro', 30 * day, now), null);
    assert.equal(reusableDebate(stored(5), 'sonar', 30 * day, now), null);
    assert.equal(reusableDebate({ ...stored(5), parts: undefined }, 'sonar-pro', 30 * day, now), null);
    assert.equal(reusableDebate(null, 'sonar-pro', 30 * day, now), null);
  });
});

describe('fetching the brief', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const answers = {
    facts: {
      events: [{ date: '2026-09-30', what: 'Made Up raised its guidance', impact: 'i', source: 'https://example.com/e', origin: 'company' }],
      kpis: [], bear_evidence: [], catalysts: [{ date: '2026-11-20', event: 'Capital markets day', watch: 'w' }],
    },
    debate: {
      debate: [{ question: 'Q?', why: 'w', settles: 's', when: '2027-01-30' }],
      bull_claims: [{ claim: 'Made-up moat', evidence: 'opinion', detail: 'd', source: 'https://example.com/b' }],
      bear_claims: [],
    },
  };
  let calls: string[] = [];
  const stub = () => {
    calls = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const user = (JSON.parse(String(init.body)) as { messages: { content: string }[] }).messages[1].content;
      const part = user.includes('"bull_claims"') ? 'debate' : 'facts';
      calls.push(part);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answers[part]) }, finish_reason: 'stop' }],
        citations: [`https://example.com/${part}`],
        usage: { cost: { total_cost: part === 'facts' ? 0.05 : 0.04 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  };

  it('asks both parts and merges them into one brief, sources and cost summed', async () => {
    stub();
    const b = await fetchPerplexity('MADE', 'Made Up Inc', 'made-up-key', 'sonar-pro');
    assert.deepEqual([...calls].sort(), ['debate', 'facts']);
    assert.equal(b.findings?.events[0].what, 'Made Up raised its guidance');
    assert.equal(b.findings?.bullClaims[0].claim, 'Made-up moat');
    assert.equal(b.findings?.catalysts?.[0].event, 'Capital markets day');
    assert.deepEqual(b.citations, ['https://example.com/facts', 'https://example.com/debate']);
    assert.ok(Math.abs(b.costUsd! - 0.09) < 1e-9);
    assert.equal(b.promptHash, PERPLEXITY_PROMPT_HASH);
    assert.equal(b.parts?.debate?.promptHash, PART_PROMPT_HASH.debate);
    assert.match(b.synthesis, /Kerndebatte/);
  });

  it('asks only the facts where a debate is kept, and keeps its day', async () => {
    stub();
    const first = await fetchPerplexity('MADE', 'Made Up Inc', 'made-up-key', 'sonar-pro');
    calls = [];
    const kept = reusableDebate(first, 'sonar-pro', 30 * 86_400_000)!;
    const b = await fetchPerplexity('MADE', 'Made Up Inc', 'made-up-key', 'sonar-pro', kept);
    assert.deepEqual(calls, ['facts']);
    assert.equal(b.parts?.debate?.fetchedAt, first.parts?.debate?.fetchedAt);
    assert.equal(b.findings?.debate?.[0].question, 'Q?');
    assert.ok(Math.abs(b.costUsd! - 0.05) < 1e-9);
  });
});
