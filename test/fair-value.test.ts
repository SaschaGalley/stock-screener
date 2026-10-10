/**
 * The test of the fair value, on prices whose answer is known: a market that
 * closes a tenth of every gap a month must come out as a slope of a tenth,
 * and a price must be placed where it stands in the models' range.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Close } from '../src/analysis/evaluate.js';
import { agreementKey, FAIR_FIELDS, fairValueStudy, positionOf, type FairRecord } from '../src/backtest/fair-value.js';

const months = ['2020-01-31', '2020-02-28', '2020-03-31', '2020-04-30', '2020-05-29', '2020-06-30', '2020-07-31', '2020-08-31'];

/** Forty stocks, each with a fixed gap from −0.5 to +0.5, gaining a tenth of it on the average stock every month. */
function market(): { records: FairRecord[]; prices: Map<string, Close[]> } {
  const records: FairRecord[] = [];
  const prices = new Map<string, Close[]>();
  for (let i = 0; i < 40; i++) {
    const symbol = `S${i}`;
    const gap = -0.5 + i / 39;
    let price = 100;
    const closes: Close[] = [];
    months.forEach((day) => {
      closes.push({ date: day, close: price });
      const fair = price * Math.exp(gap);
      const values = new Float64Array(FAIR_FIELDS.length).fill(NaN);
      const set = (k: (typeof FAIR_FIELDS)[number], v: number) => { values[FAIR_FIELDS.indexOf(k)] = v; };
      set('primary', fair);
      set('primaryMin', fair * 0.8); set('primaryP25', fair * 0.9); set('primaryP75', fair * 1.1); set('primaryMax', fair * 1.2);
      records.push({ day, symbol, price, values });
      price *= 1 + 0.1 * gap;
    });
    prices.set(symbol, closes);
  }
  return { records, prices };
}

describe('the fair value under test', () => {
  const { records, prices } = market();
  const study = fairValueStudy({
    records, prices, closes: prices,
    calendar: months.map((date) => ({ date, close: 100 })),
    sectors: new Map(),
  });

  it('measures the share of the gap that closes', () => {
    const c = study.convergence.find((x) => x.lens === 'fair.primary' && x.horizon === 1)!;
    assert.equal(c.months, months.length - 1);
    assert.ok(Math.abs(c.slope! - 0.1) < 0.01, `slope ${c.slope}`);
  });

  it('splits the gap by how far the models agree', () => {
    // Every range here is 0.8 to 1.2 of the middle: a spread of 0.4, models in agreement.
    assert.deepEqual(study.agreementShare, { agree: 1, split: 0, apart: 0 });
    const ic = study.ics.find((x) => x.key === agreementKey('agree') && x.horizon === 1)!;
    assert.ok(ic.meanIc! > 0.99);
  });

  it('ranks the returns by the gap', () => {
    const ic = study.ics.find((x) => x.key === 'fair.primary' && x.horizon === 1)!;
    assert.ok(ic.meanIc! > 0.99);
  });

  it('places the price in the range', () => {
    const v = (min: number, p25: number, p75: number, max: number) => {
      const out = new Float64Array(FAIR_FIELDS.length).fill(NaN);
      out[FAIR_FIELDS.indexOf('primaryMin')] = min; out[FAIR_FIELDS.indexOf('primaryP25')] = p25;
      out[FAIR_FIELDS.indexOf('primaryP75')] = p75; out[FAIR_FIELDS.indexOf('primaryMax')] = max;
      return out;
    };
    const range = v(80, 90, 110, 120);
    assert.equal(positionOf(70, range), 'unter der Spanne');
    assert.equal(positionOf(85, range), 'unteres Viertel');
    assert.equal(positionOf(100, range), 'mittlere Hälfte');
    assert.equal(positionOf(115, range), 'oberes Viertel');
    assert.equal(positionOf(130, range), 'über der Spanne');
    assert.equal(positionOf(100, v(80, 90, 110, NaN)), null);
  });

  it('counts the price inside the range then and later', () => {
    const r = study.ranges.find((x) => x.range === 'primary' && x.horizon === 1)!;
    // Inside 0.8–1.2 × fair when the gap is within about ±0.2: the middle stocks.
    assert.ok(r.then > 0.3 && r.then < 0.5, `then ${r.then}`);
    assert.ok(r.n > 0);
  });
});
