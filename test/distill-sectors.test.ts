/**
 * The sector mapping, and the audit that watches it.
 *
 * The table decides at runtime and Distill's search only checks it — that
 * direction is the whole point, because an alias over there can arrive from a
 * reconciliation that landed wrong, and a wrong alias must be reported rather
 * than obeyed.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { auditSectorAliases, sectorRef } from '../src/distill-sectors.js';

const KEY = 'test-key';
const BASE = 'https://distill.test';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Answer every sector search from a term → (handle, tier, ambiguous) table. */
function stubSectorSearch(
  answers: Record<string, { handle: string; tier?: string; ambiguous?: boolean } | null>,
): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const q = (new URL(String(input)).searchParams.get('q') ?? '').toLowerCase();
    asked.push(q);
    const a = answers[q];
    const body = a
      ? {
          data: [{
            id: `uuid-${a.handle}`, ref: `sector:${a.handle}`, type: 'sector',
            handle: a.handle, display_name: a.handle,
            matched_on: a.tier ?? 'alias', matched_value: q,
          }],
          total: 1,
          ambiguous: a.ambiguous ?? false,
        }
      : { data: [], total: 0, ambiguous: false };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return asked;
}

/** Everything our table claims, answered correctly. */
const AGREEING: Record<string, { handle: string }> = {
  'basic materials':        { handle: 'materials' },
  'communication services': { handle: 'communication_services' },
  'consumer cyclical':      { handle: 'consumer_discretionary' },
  'consumer defensive':     { handle: 'consumer_staples' },
  'energy':                 { handle: 'energy' },
  'financial services':     { handle: 'financials' },
  'healthcare':             { handle: 'health_care' },
  'industrials':            { handle: 'industrials' },
  'real estate':            { handle: 'real_estate' },
  'technology':             { handle: 'information_technology' },
  'utilities':              { handle: 'utilities' },
  'aerospace & defense':    { handle: 'aerospace_defense' },
};

describe('sectorRef', () => {
  it('builds the ref form Distill accepts alongside the UUID', () => {
    assert.equal(sectorRef('information_technology'), 'sector:information_technology');
  });
});

describe('auditSectorAliases', () => {
  it('is silent when Distill agrees with the table', async () => {
    stubSectorSearch(AGREEING);
    assert.deepEqual(await auditSectorAliases(KEY, BASE), []);
  });

  it('asks about every term we map, sectors and the industry alike', async () => {
    const asked = stubSectorSearch(AGREEING);
    await auditSectorAliases(KEY, BASE);

    assert.equal(asked.length, 12);
    assert.ok(asked.includes('aerospace & defense'), 'the industry entry is checked too');
  });

  it('reports a confidently wrong alias instead of following it', async () => {
    // The shape a bad reconciliation leaves: unambiguous, alias tier, wrong
    // target. Distill really did have this one, pointing at discretionary.
    stubSectorSearch({ ...AGREEING, 'consumer defensive': { handle: 'consumer_discretionary' } });

    const findings = await auditSectorAliases(KEY, BASE);

    assert.deepEqual(findings, [{
      term: 'consumer defensive', expected: 'consumer_staples',
      actual: 'consumer_discretionary', matchedOn: 'alias',
    }]);
  });

  it('counts a name-tier hit as no answer, because we would never take one', async () => {
    stubSectorSearch({ ...AGREEING, 'aerospace & defense': { handle: 'aerospace_defense', tier: 'name' } });

    const findings = await auditSectorAliases(KEY, BASE);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].actual, null, 'the hit exists but is not takeable');
    assert.equal(findings[0].matchedOn, 'name');
  });

  it('counts an ambiguous hit as no answer', async () => {
    stubSectorSearch({ ...AGREEING, technology: { handle: 'information_technology', ambiguous: true } });

    const findings = await auditSectorAliases(KEY, BASE);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].term, 'technology');
    assert.equal(findings[0].actual, null);
  });

  it('reports a term Distill no longer knows at all', async () => {
    stubSectorSearch({ ...AGREEING, 'real estate': null });

    const findings = await auditSectorAliases(KEY, BASE);

    assert.deepEqual(findings, [{
      term: 'real estate', expected: 'real_estate', actual: null, matchedOn: null,
    }]);
  });
});
