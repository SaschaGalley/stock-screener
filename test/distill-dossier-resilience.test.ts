/**
 * The promise the watchlist write path relies on: mirroring to Distill never
 * throws at its caller.
 *
 * The stock is the truth and Distill follows it, so adding or deleting one must
 * not fail because Distill is down — or, as here, because the ledger the sync
 * keeps cannot be written either. Both broken at once is the worst case, and it
 * still has to come back quietly and leave the repair to the next full sync.
 *
 * The env is set before the modules load, and the modules are therefore
 * imported dynamically: `getConfig()` caches on first call and `config.ts`
 * reads `.env` at import time, so a static import would race the setup.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.DISTILL_API_KEY = 'test-key';
process.env.DISTILL_API_URL = 'http://127.0.0.1:9';
// dotenv does not overwrite a key that is already present, empty included — so
// this really does leave the pool without a URL.
process.env.DATABASE_URL    = '';
process.env.LOG_LEVEL       = 'error';

const { dossiersFollow, noteDossierIntent } = await import('../src/distill-dossiers.js');

describe('dossiersFollow, with everything underneath it broken', () => {
  it('resolves instead of throwing when a stock is added', async () => {
    await assert.doesNotReject(() => dossiersFollow([{ symbol: 'AAPL', enabled: true }]));
  });

  it('resolves instead of throwing when a stock is deleted', async () => {
    await assert.doesNotReject(() => dossiersFollow([{ symbol: 'AAPL', enabled: false }]));
  });

  it('keeps going through the rest of a batch after one symbol fails', async () => {
    await assert.doesNotReject(() => dossiersFollow([
      { symbol: 'AAPL', enabled: true },
      { symbol: 'MSFT', enabled: false },
      { symbol: 'SAP',  enabled: true },
    ]));
  });

  it('does nothing at all for an empty batch', async () => {
    await assert.doesNotReject(() => dossiersFollow([]));
  });
});

describe('noteDossierIntent', () => {
  it('swallows a ledger it cannot write — the delete it precedes must still happen', async () => {
    await assert.doesNotReject(() => noteDossierIntent([{ symbol: 'AAPL', enabled: false }]));
  });
});
