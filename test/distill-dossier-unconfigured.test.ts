/**
 * Most installations have no Distill key at all. For them the dossier switch
 * must be inert: no requests, no errors, and no change to what adding or
 * deleting a stock does.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

// Set before the dynamic import below — see the note in the resilience test.
process.env.DISTILL_API_KEY = '';
process.env.LOG_LEVEL       = 'error';

const { dossiersFollow, resolveEntityId, syncWatchlistDossiers } =
  await import('../src/distill-dossiers.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function forbidFetch(): () => number {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('', { status: 200 }); }) as typeof fetch;
  return () => calls;
}

describe('with no DISTILL_API_KEY', () => {
  it('a watchlist change sends nothing', async () => {
    const calls = forbidFetch();
    await dossiersFollow([{ kind: 'company', subject: 'AAPL', enabled: true }]);
    assert.equal(calls(), 0);
  });

  it('resolving reports the missing key rather than pretending to have looked', async () => {
    const calls = forbidFetch();
    assert.deepEqual(await resolveEntityId({ kind: 'company', subject: 'AAPL' }), { id: null, detail: 'DISTILL_API_KEY not set' });
    assert.equal(calls(), 0);
  });

  it('a full sync says why it did not run, instead of reporting a clean zero', async () => {
    const calls = forbidFetch();
    const summary = await syncWatchlistDossiers();
    assert.equal(summary.aborted, 'DISTILL_API_KEY not set');
    assert.equal(calls(), 0);
  });
});
