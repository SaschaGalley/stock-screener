/**
 * What counts as a peer.
 *
 * Berkshire's B shares were benchmarked against its A shares, and a loss-making
 * peer's negative P/E dragged a median down as if it were a cheap valuation.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getSectorMedians } from '../src/data/finnhub.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function serve(peers: string[] | Record<string, string[]>, metrics: Record<string, Record<string, number>>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/stock/peers')) {
      return Response.json(Array.isArray(peers) ? peers : peers[url.searchParams.get('grouping')!] ?? []);
    }
    return Response.json({ metric: metrics[url.searchParams.get('symbol')!] ?? {} });
  }) as typeof fetch;
}

describe('peer group', () => {
  it('leaves out the company under another share class, by ticker and by market cap', async () => {
    serve(['BRK-B', 'BRK.A', 'FOXA', 'P1', 'P2'], {
      'BRK-B': { marketCapitalization: 1_000_000, peTTM: 13 },
      'BRK.A': { marketCapitalization: 1_000_000, peTTM: 13 },
      FOXA:    { marketCapitalization: 1_000_000, peTTM: 13 },  // no shared ticker root, same company size
      P1:      { marketCapitalization: 50_000, peTTM: 20 },
      P2:      { marketCapitalization: 80_000, peTTM: 30 },
    });
    const m = await getSectorMedians('BRK-B', 'key');
    assert.deepEqual(m?.peers, ['P1', 'P2']);
    assert.equal(m?.pe, 25);
  });

  it('does not read a loss as a cheap multiple', async () => {
    serve(['SELF', 'L1', 'L2', 'L3', 'P1', 'P2', 'P3', 'P4', 'P5'], {
      L1: { peTTM: -40 }, L2: { peTTM: -15 }, L3: { peTTM: -8 },
      P1: { peTTM: 12 }, P2: { peTTM: 18 }, P3: { peTTM: 22 }, P4: { peTTM: 25 }, P5: { peTTM: 30 },
    });
    assert.equal((await getSectorMedians('SELF', 'key'))?.pe, 22);
  });

  it('prefers the sub-industry and drops shells a fiftieth of the company\'s size', async () => {
    serve({ subIndustry: ['BRK.A', 'CODI', 'CNNE'], industry: ['V', 'MA', 'PYPL'] }, {
      'BRK-B': { marketCapitalization: 1_000_000 },
      CODI: { marketCapitalization: 900, peTTM: 8 }, CNNE: { marketCapitalization: 400, peTTM: 30 },
      V: { marketCapitalization: 600_000, peTTM: 30 }, MA: { marketCapitalization: 550_000, peTTM: 35 },
      PYPL: { marketCapitalization: 70_000, peTTM: 15 },
    });
    // An insurer does not fall back to the payment networks: no group is the answer.
    const insurer = await getSectorMedians('BRK-B', 'key', { industryFallback: false });
    assert.equal(insurer?.emptyGroup, true);
    assert.equal(insurer?.peerCount, 0);
    // Anyone else may widen to the industry when the sub-industry is empty.
    const other = await getSectorMedians('BRK-B', 'key');
    assert.deepEqual(other?.peers, ['V', 'MA', 'PYPL']);
  });
});
