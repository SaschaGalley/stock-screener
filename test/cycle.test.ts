/**
 * Today's margins against the company's own years. The companies are made up.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CYCLE_CANDIDATES, cycleReading, marginYearsFromFinnhub, type MarginHistory, type MarginYear,
} from '../src/analysis/cycle.js';
import type { StockFinancials } from '../src/types.js';

/** Years from 2006 with the given operating margins; net margin at three quarters of it, FCF margin at 0.2. */
const history = (ops: number[]): MarginHistory => ({
  source: 'finnhub',
  years: ops.map((op, k): MarginYear => ({ year: 2006 + k, operatingMargin: op, netMargin: op * 0.75, fcfMargin: 0.2 })),
});
const today = (op: number) => ({ operatingMargin: op, netMargin: op * 0.75, fcfMargin: 0.2 });

/** A miner: margins between 5 % and 20 % for twenty years. */
const miner = history([0.10, 0.15, 0.20, 0.05, 0.08, 0.12, 0.18, 0.06, 0.09, 0.11, 0.14, 0.10, 0.07, 0.13, 0.16, 0.10, 0.12, 0.09, 0.11, 0.10]);

describe('the margin cycle', () => {
  it('calls a record far above the median a peak, and prices it on the median', () => {
    const r = cycleReading(miner, today(0.40), 10)!;
    const op = r.lines.find((l) => l.key === 'operatingMargin')!;
    assert.equal(r.level, 'peak');
    assert.equal(op.record, true);
    assert.equal(op.rank, 1);
    assert.equal(op.window, 10);
    assert.ok(Math.abs(op.median - 0.105) < 1e-12, 'the median of the last ten years');
    // Net margin 0.30 against a median of 0.07875: the P/E of 10 reads 38.1.
    assert.ok(Math.abs(r.normalizedPE! - 10 * 0.30 / 0.07875) < 1e-9);
  });

  it('calls a slow climb near the top high, not a peak', () => {
    // Rising a point a year: today is above every year but only a little above the median.
    const climber = history(Array.from({ length: 12 }, (_, k) => 0.30 + k * 0.01));
    const r = cycleReading(climber, today(0.42), 25)!;
    assert.equal(r.level, 'high');
  });

  it('calls a slump far below the median a trough', () => {
    assert.equal(cycleReading(miner, today(0.04), null)!.level, 'trough');
  });

  it('reads an ordinary year as normal', () => {
    assert.equal(cycleReading(miner, today(0.11), 15)!.level, 'normal');
  });

  it('says nothing about a peak where the median is a loss', () => {
    const loser = history([-0.2, -0.1, -0.3, -0.15, -0.05, -0.1]);
    const r = cycleReading(loser, today(0.05), null)!;
    assert.equal(r.level, 'high', 'above every year, but no median to be far above');
    assert.equal(r.normalizedPE, null);
  });

  it('needs five years', () => {
    assert.equal(cycleReading(history([0.1, 0.2, 0.3, 0.2]), today(0.3), 10), null);
  });
});

describe('the years from Finnhub', () => {
  it('labels each fiscal year with the year its period ends in', () => {
    const years = marginYearsFromFinnhub({
      annual: {
        operatingMargin: [{ period: '2026-01-25', v: 0.6 }, { period: '2025-01-26', v: 0.5 }],
        netMargin: [{ period: '2026-01-25', v: 0.55 }],
      },
    });
    assert.deepEqual(years, [
      { year: 2025, operatingMargin: 0.5, netMargin: null, fcfMargin: null },
      { year: 2026, operatingMargin: 0.6, netMargin: 0.55, fcfMargin: null },
    ]);
  });
});

describe('the cycle candidates', () => {
  const f = {
    marketCap: 1000,
    fundamentalsHistory: {
      revenue: [2021, 2022, 2023, 2024, 2025].map((year) => ({ year, value: 1000 })),
      operatingIncome: [100, 120, 80, 110, 200].map((value, k) => ({ year: 2021 + k, value })),
      netIncome: [80, 90, 60, 85, 150].map((value, k) => ({ year: 2021 + k, value })),
      freeCashFlow: [],
    },
  } as unknown as StockFinancials;
  const read = (key: string) => CYCLE_CANDIDATES.find((c) => c.key === key)!.read(f);

  it('reads the newest margin against the median of the years before', () => {
    // 20 % against the median of 10, 12, 8 and 11 %.
    assert.ok(Math.abs(read('cycle.margin-vs-past')! - (0.20 - 0.105)) < 1e-12);
  });

  it('reads earnings at the median net margin over the market value', () => {
    // Median net margin 8.5 % of revenue 1000, over a market value of 1000.
    assert.ok(Math.abs(read('cycle.normalized-earnings-yield')! - 0.085) < 1e-12);
  });
});
