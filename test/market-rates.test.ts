/**
 * Market rates: what was read, what was assumed, and which currency's yield a
 * stock is discounted at.
 *
 * The contract that matters is provenance. A fallback may feed a valuation —
 * better an assumed spread than no DCF — but it must never be recorded as the
 * day's reading, and a reading that failed must be retried in minutes rather
 * than kept for the hour a good one is.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

import { FALLBACK_RATES, getMarketRates, ratesForCurrency } from '../src/data/fred.js';
import { ratingForCoverage } from '../src/data/ratings.js';
import { erpWorkbook } from './support/xlsx.js';

const MINUTE = 60_000;

/** What each stubbed upstream answers: a FRED value in percent, or null for an outage. */
let fredAnswer: (series: string) => string | null = () => null;
let damodaranUp = true;
const asked: string[] = [];

const realFetch = globalThis.fetch;

before(() => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 15) });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.stlouisfed.org') {
      const series = url.searchParams.get('series_id') ?? '';
      asked.push(series);
      const value = fredAnswer(series);
      return value === null
        ? new Response('unavailable', { status: 500 })
        : Response.json({ observations: [{ value }] });
    }
    asked.push(url.hostname);
    return damodaranUp
      ? new Response(new Uint8Array(erpWorkbook(0.0409)))
      : new Response('unavailable', { status: 503 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

/** Every FRED series answers, with the Treasury, the Bund and BBB spread at recognisable values. */
const everySeries = (series: string): string =>
  series === 'DGS10' ? '4.96'
  : series === 'DAAA' ? '6.03'
  : series === 'IRLTLT01DEM156N' ? '2.97'
  : series === 'BAMLC0A4CBBB' ? '0.97'
  : '1.00';

// These run in order against one module instance: its memo is the thing under test.
describe('market rates', () => {
  it('marks what it read, and fills the rest from the constants', async () => {
    fredAnswer = (s) => (s === 'DAAA' ? null : everySeries(s));
    const rates = await getMarketRates('key');

    assert.equal(rates.riskFreeRate, 0.0496);
    assert.equal(rates.observed.riskFreeRate, 0.0496);
    assert.equal(rates.aaaBondYield, FALLBACK_RATES.aaaBondYield);
    assert.equal(rates.observed.aaaBondYield, undefined, 'a fallback is not an observation');
    assert.equal(rates.observed.equityRiskPremium, 0.0409);
    assert.equal(rates.creditSpreads.BBB, 0.0097);
    assert.equal(rates.localRiskFreeRates.EUR, 0.0297);
  });

  it('retries an incomplete reading within minutes, not the hour', async () => {
    const before = asked.length;
    mock.timers.tick(MINUTE);
    await getMarketRates('key');
    assert.equal(asked.length, before, 'still cached a minute later');

    fredAnswer = everySeries;
    mock.timers.tick(5 * MINUTE);
    const rates = await getMarketRates('key');
    assert.ok(asked.length > before, 'asked again after five minutes');
    assert.equal(rates.observed.aaaBondYield, 0.0603);
  });

  it('keeps a complete reading for the hour', async () => {
    const before = asked.length;
    mock.timers.tick(30 * MINUTE);
    await getMarketRates('key');
    assert.equal(asked.length, before);
  });

  it('falls back to the last reading rather than the constant, and does not record it again', async () => {
    fredAnswer = () => null;
    damodaranUp = false;
    mock.timers.tick(13 * 60 * MINUTE);   // past the premium's twelve hours as well
    const rates = await getMarketRates('key');

    assert.equal(rates.riskFreeRate, 0.0496, 'the last Treasury reading, not 4.5%');
    assert.equal(rates.equityRiskPremium, 0.0409, 'the last premium, not 5.5%');
    assert.deepEqual(rates.observed, { creditSpreads: {}, localRiskFreeRates: {} });
  });

  it('reads the premium without a FRED key, and asks FRED for nothing', async () => {
    damodaranUp = true;
    mock.timers.tick(6 * MINUTE);
    const before = asked.length;
    const rates = await getMarketRates(undefined);

    assert.deepEqual(asked.slice(before), ['pages.stern.nyu.edu']);
    assert.equal(rates.observed.equityRiskPremium, 0.0409);
    assert.equal(rates.observed.riskFreeRate, undefined);
  });
});

describe('rates for a currency', () => {
  const rates = { ...FALLBACK_RATES, riskFreeRate: 0.0496, localRiskFreeRates: { EUR: 0.0297, GBP: 0.048 } };

  it('discounts euro cash flows at the Bund', () => {
    assert.equal(ratesForCurrency(rates, 'EUR').riskFreeRate, 0.0297);
  });

  it('reads London pence as pounds', () => {
    assert.equal(ratesForCurrency(rates, 'GBp').riskFreeRate, 0.048);
  });

  it('keeps the dollar rate for dollars and for currencies without a series', () => {
    assert.equal(ratesForCurrency(rates, 'USD'), rates);
    assert.equal(ratesForCurrency(rates, 'HKD'), rates);
    assert.equal(ratesForCurrency(rates, null), rates);
  });
});

describe('synthetic rating', () => {
  it("follows Damodaran's coverage thresholds at the bucket edges", () => {
    assert.equal(ratingForCoverage(8.5), 'AAA');
    assert.equal(ratingForCoverage(8.49), 'AA');
    assert.equal(ratingForCoverage(3), 'A');
    assert.equal(ratingForCoverage(2.99), 'BBB');
    assert.equal(ratingForCoverage(2), 'BB');
    assert.equal(ratingForCoverage(1.25), 'B');
    assert.equal(ratingForCoverage(1.24), 'CCC');
  });

  it('puts operating losses and unusable coverage in the bottom bucket', () => {
    assert.equal(ratingForCoverage(-3), 'CCC');
    assert.equal(ratingForCoverage(Number.NaN), 'CCC');
  });
});
