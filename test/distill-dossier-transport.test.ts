/**
 * The dossier switch as seen from the wire.
 *
 * The point of these is the status codes: Distill answers four different 4xx
 * and each one asks for a different move, so the transport must not flatten
 * them into "request failed". The retry behaviour is here too, because "retry
 * 5xx but never a 4xx" is the other half of the same decision.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  getDistillDossier,
  setDistillDossier,
} from '../src/data/distill-dossier.js';
import {
  DistillDossierIneligibleError,
  DistillDossierScopeError,
  DistillEntityGoneError,
  DistillUnauthorizedError,
} from '../src/data/distill-errors.js';

const KEY  = 'test-key';
const BASE = 'https://distill.test';
const ID   = '11111111-2222-3333-4444-555555555555';

/** No sleeping in tests: an empty schedule means "one attempt, no retries". */
const NO_RETRY = { retryDelaysMs: [] as number[] };

interface Call { url: string; method: string; headers: Record<string, string>; body: string | null }

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(replies: { status: number; body?: unknown }[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url:     String(input),
      method:  init?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      body:    typeof init?.body === 'string' ? init.body : null,
    });
    // The last reply repeats, so "always 500" is one entry.
    const reply = replies[Math.min(i++, replies.length - 1)];
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status:  reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

describe('setDistillDossier', () => {
  it('PUTs the switch to the entity path and reports what came back', async () => {
    const calls = stubFetch([{ status: 200, body: { ref: 'company:microsoft', id: ID, enabled: true } }]);

    const state = await setDistillDossier(ID, true, KEY, BASE, NO_RETRY);

    assert.deepEqual(state, { ref: 'company:microsoft', id: ID, enabled: true, eligible: null });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/api/v1/entities/${ID}/dossier`);
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].body, '{"enabled":true}');
  });

  it('sends enabled:false the same way — the project is in the key, never the URL', async () => {
    const calls = stubFetch([{ status: 200, body: { ref: 'company:microsoft', id: ID, enabled: false } }]);

    const state = await setDistillDossier(ID, false, KEY, BASE, NO_RETRY);

    assert.equal(state.enabled, false);
    assert.equal(calls[0].body, '{"enabled":false}');
    assert.ok(!calls[0].url.includes('project'), 'the project must not appear in the URL');
  });

  it('trims a trailing slash off the base URL rather than doubling it', async () => {
    const calls = stubFetch([{ status: 200, body: { id: ID, enabled: true } }]);
    await setDistillDossier(ID, true, KEY, `${BASE}/`, NO_RETRY);
    assert.equal(calls[0].url, `${BASE}/api/v1/entities/${ID}/dossier`);
  });

  // ── The four 4xx, which are four different problems ────────────────────────

  it('403 is a missing scope: named as such, and not retried', async () => {
    const calls = stubFetch([{ status: 403, body: { error: 'forbidden' } }]);

    await assert.rejects(
      () => setDistillDossier(ID, true, KEY, BASE, { retryDelaysMs: [0, 0] }),
      DistillDossierScopeError,
    );
    assert.equal(calls.length, 1, 'a scope error repeats identically — retrying it is waste');
  });

  it('404 is a stale id, so it surfaces as gone-and-re-resolvable, carrying the id', async () => {
    stubFetch([{ status: 404 }]);
    await assert.rejects(
      () => setDistillDossier(ID, true, KEY, BASE, NO_RETRY),
      (e: unknown) => e instanceof DistillEntityGoneError && e.entityId === ID,
    );
  });

  it('409 is the entity type being ineligible — a standing condition, not a failure', async () => {
    stubFetch([{ status: 409, body: { error: 'entity type may not host a dossier' } }]);
    await assert.rejects(
      () => setDistillDossier(ID, true, KEY, BASE, NO_RETRY),
      (e: unknown) => e instanceof DistillDossierIneligibleError && e.entityId === ID,
    );
  });

  it('401 stays distinct from 403 — a wrong token is a different fix than a wrong scope', async () => {
    stubFetch([{ status: 401 }]);
    await assert.rejects(
      () => setDistillDossier(ID, true, KEY, BASE, NO_RETRY),
      DistillUnauthorizedError,
    );
  });

  // ── 5xx and transport ──────────────────────────────────────────────────────

  it('retries a 5xx and succeeds when the next attempt does', async () => {
    const calls = stubFetch([
      { status: 503 },
      { status: 200, body: { id: ID, enabled: true } },
    ]);

    const state = await setDistillDossier(ID, true, KEY, BASE, { retryDelaysMs: [0] });

    assert.equal(state.enabled, true);
    assert.equal(calls.length, 2);
  });

  it('gives up after the schedule runs out, and says what the last failure was', async () => {
    const calls = stubFetch([{ status: 500, body: { error: 'boom' } }]);

    await assert.rejects(
      () => setDistillDossier(ID, true, KEY, BASE, { retryDelaysMs: [0, 0] }),
      /500/,
    );
    assert.equal(calls.length, 3, 'one attempt per delay, plus the first');
  });

  it('retries a dropped connection too', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ id: ID, enabled: false }), { status: 200 });
    }) as typeof fetch;

    const state = await setDistillDossier(ID, false, KEY, BASE, { retryDelaysMs: [0] });

    assert.equal(state.enabled, false);
    assert.equal(attempts, 2);
  });
});

describe('getDistillDossier', () => {
  it('reads the switch and the eligibility flag that only the GET reports', async () => {
    const calls = stubFetch([{ status: 200, body: { ref: 'company:microsoft', id: ID, enabled: true, eligible: true } }]);

    const state = await getDistillDossier(ID, KEY, BASE, NO_RETRY);

    assert.deepEqual(state, { ref: 'company:microsoft', id: ID, enabled: true, eligible: true });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, null);
  });
});
