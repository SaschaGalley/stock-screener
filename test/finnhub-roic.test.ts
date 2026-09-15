/**
 * ROIC from Finnhub.
 *
 * It was read from `metric.roicTTM`, a key Finnhub has never published, so the
 * field was null for every stock and every peer group. The figure lives in the
 * annual series; these tests pin where it is read from and which point wins.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getBasicFinancials, getSectorMedians } from '../src/data/finnhub.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A /stock/metric body whose annual ROIC series is deliberately out of order. */
const metricBody = (roics: [string, number][]) => ({
  metric: { epsGrowth3Y: 6.89, dividendGrowthRate5Y: 4.95, roiTTM: 70.25 },
  series: { annual: { roic: roics.map(([period, v]) => ({ period, v })) } },
});

describe('Finnhub ROIC', () => {
  it('takes the newest annual point, already a decimal', async () => {
    globalThis.fetch = (async () => Response.json(metricBody([
      ['2023-09-30', 0.5566], ['2025-09-27', 0.6451], ['2024-09-28', 0.5699],
    ]))) as typeof fetch;

    const m = await getBasicFinancials('AAPL', 'key');
    assert.equal(m.roic, 0.6451);
    assert.equal(m.epsGrowth3Y, 0.0689);
  });

  it('is null when the series is missing, not ROI in disguise', async () => {
    globalThis.fetch = (async () => Response.json({ metric: { roiTTM: 16.7 } })) as typeof fetch;
    assert.equal((await getBasicFinancials('AIR.PA', 'key')).roic, null);
  });

  it('feeds the peer median from the same series', async () => {
    const peerRoic: Record<string, number> = { P1: 0.10, P2: 0.20, P3: 0.30 };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/stock/peers')) return Response.json(['SELF', 'P1', 'P2', 'P3']);
      return Response.json(metricBody([['2025-12-31', peerRoic[url.searchParams.get('symbol')!]]]));
    }) as typeof fetch;

    assert.equal((await getSectorMedians('SELF', 'key'))?.roic, 0.20);
  });
});
