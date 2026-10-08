/** What came of made-up depot checks. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DepotCheckResult, ManagerAction } from '../src/analysis/depot-check.js';
import { changesSince, checkSteps, groupRecord, stepHit, type StepOutcome } from '../src/analysis/depot-check-record.js';

const stock = (symbol: string) => ({
  symbol, name: `${symbol} Corp`, sector: null, score: null, verdict: null, scoreBefore: null, chart: null, weight: null, error: null,
});
const check = (at: string, moves: [string, ManagerAction][], buy: string[] = []): DepotCheckResult => ({
  generatedAt: at, settings: { minScore: 8, maxCandidates: 2, reduceBelow: 5 }, model: 'made-up',
  candidates: buy.map(stock), holdings: moves.map(([s]) => stock(s)),
  lists: { buy: buy.map(stock), waitForChart: [], dropped: [], reduce: [], watch: [] },
  manager: { summary: '', moves: moves.map(([symbol, action]) => ({ symbol, action, reason: '' })), risks: [] }, managerError: null,
});

describe('the check record', () => {
  const older = check('2026-09-01T08:00:00Z', [['AAA', 'halten'], ['BBB', 'reduzieren']], ['NEW']);
  const newer = check('2026-09-29T08:00:00Z', [['AAA', 'gewinne mitnehmen'], ['NEW', 'kaufen']]);

  it('takes every step of every check, the lists beside the moves', () => {
    const steps = checkSteps([{ id: 2, result: newer }, { id: 1, result: older }]);
    assert.deepEqual(steps.map((s) => `${s.day} ${s.group} ${s.symbol}`), [
      '2026-09-29 gewinne mitnehmen AAA', '2026-09-29 kaufen NEW',
      '2026-09-01 halten AAA', '2026-09-01 reduzieren BBB', '2026-09-01 liste: kaufen ansehen NEW',
    ]);
  });

  it('scores a step by the way it bet, and not a hold', () => {
    assert.equal(stepHit('kaufen', 0.03), true);
    assert.equal(stepHit('reduzieren', 0.03), false);
    assert.equal(stepHit('gewinne mitnehmen', -0.01), true);
    assert.equal(stepHit('halten', 0.03), null);
    assert.equal(stepHit('kaufen', null), null);
  });

  it('sums each kind of step', () => {
    const o = (group: StepOutcome['group'], excess: number | null, day = '2026-09-01'): StepOutcome =>
      ({ key: `${group}${excess}`, checkAt: day, day, symbol: 'X', name: null, group, stock: excess, excess, hit: stepHit(group, excess) });
    const r = groupRecord([o('kaufen', 0.04), o('kaufen', -0.02), o('kaufen', 0.01), o('halten', 0.02), o('kaufen', null)], '2026-10-01');
    assert.deepEqual(r.map((g) => [g.group, g.n, g.measured, g.hits, g.scored]), [['kaufen', 4, 3, 2, 3], ['halten', 1, 1, 0, 0]]);
    assert.equal(r[0].medianExcess, 0.01);
    assert.equal(r[0].medianDays, 30);
  });

  it('says what the newest check changed', () => {
    assert.deepEqual(changesSince(older, newer).map((c) => [c.symbol, c.from, c.to]), [
      ['AAA', 'halten', 'gewinne mitnehmen'], ['BBB', 'reduzieren', null], ['NEW', null, 'kaufen'],
    ]);
    assert.deepEqual(changesSince(null, newer), []);
  });
});
