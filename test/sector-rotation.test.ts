/** The sector funds against the index, on made-up closes. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sectorPhase, sectorTrends } from '../src/analysis/sector-rotation.js';

/** 130 sessions: flat at 100 for the first, then `path(k)` for session k. */
const series = (path: (k: number) => number) =>
  Array.from({ length: 130 }, (_, k) => ({ day: `d${String(k).padStart(3, '0')}`, close: path(k) }));

describe('sector trends', () => {
  it('names the quadrant from three months against the index and the last month', () => {
    assert.equal(sectorPhase(0.05, 0.01), 'führt');
    assert.equal(sectorPhase(0.05, -0.01), 'verliert Schwung');
    assert.equal(sectorPhase(-0.05, -0.01), 'hinkt');
    assert.equal(sectorPhase(-0.05, 0.01), 'holt auf');
    assert.equal(sectorPhase(null, 0.01), null);
  });

  it('measures each fund against the index, strongest first', () => {
    const closes = new Map([
      ['IDX', series(() => 100)],
      // Up steadily: ahead over every window.
      ['UP', series((k) => 100 + k * 0.2)],
      // Up into the last month, then down: ahead over three months, behind over one.
      ['TOP', series((k) => (k < 109 ? 100 + k * 0.3 : 132.7 - (k - 109) * 0.5))],
      ['NONE', []],
    ]);
    const t = sectorTrends([
      { sector: 'Rising', etf: 'UP' }, { sector: 'Topping', etf: 'TOP' }, { sector: 'Missing', etf: 'NONE' },
    ], closes, 'IDX');
    assert.deepEqual(t.map((x) => [x.sector, x.phase]), [['Rising', 'führt'], ['Topping', 'verliert Schwung'], ['Missing', null]]);
    assert.ok(Math.abs(t[0].r1m! - (125.8 / 121.6 - 1)) < 1e-9);
    assert.equal(t[0].rel1m, t[0].r1m, 'the index stood still');
  });
});
