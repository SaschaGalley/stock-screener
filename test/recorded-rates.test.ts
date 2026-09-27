/**
 * A rate that fails to load falls back to the last one the refresh recorded,
 * before any constant — and is not recorded again as today's reading.
 *
 * Its own file because the rate memo is per process, and the test runner gives
 * each file a fresh one: this is what a CLI run or a new server start sees.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { FALLBACK_RATES, getMarketRates, useRecordedRates } from '../src/data/fred.js';

const realFetch = globalThis.fetch;

before(() => {
  // Every upstream down: Damodaran timing out is the case this exists for.
  globalThis.fetch = (async () => { throw new Error('The operation was aborted due to timeout'); }) as typeof fetch;
  useRecordedRates(async () => new Map([
    ['macro.equityRiskPremium', 0.0409],
    ['macro.riskFreeRate', 0.0463],
    ['macro.creditSpreads.BBB', 0.0095],
  ]));
});

after(() => {
  globalThis.fetch = realFetch;
});

describe('recorded rates as the fallback', () => {
  it('discounts with the last recorded premium, not the long-run constant', async () => {
    const rates = await getMarketRates('key');
    assert.equal(rates.equityRiskPremium, 0.0409);
    assert.equal(rates.riskFreeRate, 0.0463);
    assert.equal(rates.creditSpreads.BBB, 0.0095);
    // Nothing recorded for these: the constants are still the last resort.
    assert.equal(rates.aaaBondYield, FALLBACK_RATES.aaaBondYield);
    assert.equal(rates.creditSpreads.AAA, FALLBACK_RATES.creditSpreads.AAA);
  });

  it('never reports a recorded value as observed today', async () => {
    const rates = await getMarketRates('key');
    assert.equal(rates.observed.equityRiskPremium, undefined);
    assert.equal(rates.observed.riskFreeRate, undefined);
    assert.deepEqual(rates.observed.creditSpreads, {});
  });
});
