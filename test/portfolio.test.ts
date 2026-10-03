/**
 * The portfolios on a market whose answer is known: the stocks the signal
 * ranks highest grow two per cent a month, the rest none, the index one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Close } from '../src/analysis/evaluate.js';
import { COST_PER_SIDE, PORTFOLIO_SIGNALS, portfolioStudy, type PortfolioRecord } from '../src/backtest/portfolio.js';

const months = Array.from({ length: 30 }, (_, k) => {
  const d = new Date(Date.UTC(2018 + Math.floor((k + 6) / 12), (k + 6) % 12 + 1, 0));
  return d.toISOString().slice(0, 10);
});

function market() {
  const records: PortfolioRecord[] = [];
  const prices = new Map<string, Close[]>();
  for (let i = 0; i < 100; i++) {
    const symbol = `S${String(i).padStart(3, '0')}`;
    const top = i < 25;
    prices.set(symbol, months.map((date, k) => ({ date, close: 100 * (top ? 1.02 : 1) ** k })));
    for (const day of months) {
      records.push({ day, symbol, values: Float64Array.from(PORTFOLIO_SIGNALS, () => (top ? 10 - i / 100 : i / 100)) });
    }
  }
  const index = (g: number) => months.map((date, k) => ({ date, close: 100 * g ** k }));
  return { records, prices, benchmarks: new Map([['SPY', index(1.01)], ['URTH', index(1.01)]]) };
}

describe('portfolios against the index', () => {
  const { records, prices, benchmarks } = market();
  const study = portfolioStudy({ records, prices, benchmarks, calendar: months });

  it('holds the top of the signal, and pays to buy it once when it never changes', () => {
    const run = study.runs.find((r) => r.signal === 'score' && r.size === 25 && r.every === 3)!;
    // Two per cent a month, less one purchase over the 29 months.
    const expected = (1.02 ** 29 * (1 - COST_PER_SIDE)) ** (12 / 29) - 1;
    assert.ok(Math.abs(run.cagr! - expected) < 1e-9, `${run.cagr} vs ${expected}`);
    assert.equal(run.turnover, 0);
    assert.ok(run.vs.URTH.excess! > 0.1);
    assert.equal(run.vs.URTH.yearsAhead, run.vs.URTH.years);
  });

  it('marks the index and the average stock on the same month-ends', () => {
    const urth = study.benchmarks.find((b) => b.key === 'URTH')!;
    assert.ok(Math.abs(urth.cagr! - (1.01 ** 12 - 1)) < 1e-9);
    // A quarter of the stocks at two per cent, the rest flat: half a per cent a month on average, rebalanced.
    assert.ok(Math.abs(study.universe.cagr! - (1.005 ** 12 - 1)) < 1e-9);
  });

  it('judges the rule on 25 stocks, quarterly, in both halves', () => {
    const v = study.verdicts.find((x) => x.key === 'score-vs-index')!;
    assert.equal(v.holds, true);
  });
});
