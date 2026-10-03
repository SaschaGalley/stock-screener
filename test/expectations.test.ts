/**
 * The rule the live months are judged by was fixed before they came in; these
 * tests keep it what it was fixed as.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXPECTATIONS, judge, monthsToDecide, type Expectation } from '../src/backtest/expectations.js';
import { closedMonthEnds } from '../src/backtest/prices.js';

const ic: Expectation = EXPECTATIONS.find((e) => e.key === 'ic-1m')!;
const band: Expectation = EXPECTATIONS.find((e) => e.key === 'band8-6m')!;

describe('the expectations fixed on 3 October 2026', () => {
  it('reads nothing into fewer than six windows', () => {
    assert.equal(judge(ic, { mean: 0.2, t: 9, windows: 5 }).status, 'zu früh');
  });

  it('confirms at two standard errors in the expected direction, and contradicts at two against', () => {
    assert.equal(judge(ic, { mean: 0.03, t: 2.1, windows: 24 }).status, 'bestätigt');
    assert.equal(judge(ic, { mean: -0.03, t: -2.1, windows: 24 }).status, 'widerlegt');
    assert.equal(judge(ic, { mean: 0.01, t: 1.2, windows: 24 }).status, 'offen');
    // An expectation of a shortfall is confirmed by a negative reading.
    assert.equal(judge(band, { mean: -0.05, t: -2.4, windows: 8 }).status, 'bestätigt');
  });

  it("says whether the backtest's value lies inside the live interval", () => {
    // 0.03 ± 1.96 × 0.015: from about 0.0006 to 0.0594, the backtest's 0.0145 inside.
    const j = judge(ic, { mean: 0.03, t: 2, windows: 24 });
    assert.ok(Math.abs(j.low! - 0.0006) < 1e-9 && Math.abs(j.high! - 0.0594) < 1e-9);
    assert.equal(j.consistent, true);
    assert.equal(judge(ic, { mean: -0.05, t: -2.5, windows: 24 }).consistent, false);
  });

  it("counts the months an effect the backtest's size needs to reach two standard errors", () => {
    // (2 / 2.3)² × 165 windows of a month.
    assert.equal(monthsToDecide(ic), 125);
    // (2 / 1.33)² × 27 windows of six months.
    assert.equal(monthsToDecide(band), 62 * 6);
  });
});

describe('months that are over', () => {
  it('leaves out the month still running, which a window would measure in days', () => {
    const dates = ['2026-08-31', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
    assert.deepEqual(closedMonthEnds(dates, '2026-08-01', '2026-10-02', '2026-10-03'), ['2026-08-31', '2026-09-30']);
    assert.deepEqual(closedMonthEnds(dates, '2026-08-01', '2026-10-02', '2026-11-01'), ['2026-08-31', '2026-09-30', '2026-10-02']);
  });
});
