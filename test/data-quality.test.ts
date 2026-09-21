/**
 * The margin cross-check, and the one comparison it must refuse to make.
 *
 * This check earns its keep — on a real watchlist its findings included a
 * trailing net margin of −230 % against a fiscal year of +1.6 %, which is a
 * payload problem however you read it. What it must not do is divide by
 * approximately zero: Intel's annual operating margin rounded to 0.0 %, and a
 * relative gap against that produced a "280× disagreement" that was a statement
 * about the denominator and nothing about Intel.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { auditFinancials } from '../src/analysis/data-quality.js';
import type { StockFinancials } from '../src/types.js';

function financials(over: Partial<StockFinancials> = {}): StockFinancials {
  return {
    symbol: 'TEST',
    mostRecentQuarter: new Date().toISOString().slice(0, 10),
    revenue: 1_000_000,
    earningsEstimates: [],
    operatingMargin: 0.10,
    netMargin: 0.08,
    fundamentalsHistory: {
      revenue: [{ year: 2025, value: 1_000_000 }],
      operatingIncome: [{ year: 2025, value: 100_000 }],
      netIncome: [{ year: 2025, value: 80_000 }],
      grossProfit: [], eps: [], freeCashFlow: [], operatingCashFlow: [],
      totalAssets: [], stockholdersEquity: [],
    },
    ...over,
  } as unknown as StockFinancials;
}

const margins = (f: StockFinancials) => auditFinancials(f).filter((w) => w.code === 'margin-mismatch');

describe('margin cross-check', () => {
  it('stays quiet when the trailing margin matches the fiscal year', () => {
    assert.equal(margins(financials()).length, 0);
  });

  it('reports a factor-level gap, naming both bases', () => {
    // Trailing 1 % against an annual 10 %: either the business fell off a cliff
    // or the trailing figure stopped moving, and the reader is told it is one
    // of those two rather than which.
    const w = margins(financials({ operatingMargin: 0.01 }));
    assert.equal(w.length, 1);
    assert.match(w[0].message, /Trailing/);
    assert.match(w[0].message, /newest full fiscal year/);
    assert.match(w[0].message, /different periods/);
  });

  it('refuses to measure a ratio against a margin of nearly zero', () => {
    // Intel's shape: the annual side rounds to zero, so every trailing value is
    // an infinite relative gap from it. Both orderings, because either side can
    // be the near-zero one.
    const annualZero = financials({
      operatingMargin: 0.12,
      fundamentalsHistory: {
        ...financials().fundamentalsHistory,
        operatingIncome: [{ year: 2025, value: -50 }],   // −0.005 % of revenue
      },
    } as Partial<StockFinancials>);
    const trailingZero = financials({ operatingMargin: -0.001 });

    assert.equal(margins(annualZero).length, 0);
    assert.equal(margins(trailingZero).length, 0);
  });

  it('still fires when both sides are far from zero and disagree in sign', () => {
    // Lumentum's shape: +28 % trailing against −12 % annual. Nothing here is
    // near zero, and opposite signs are worth saying out loud.
    const w = margins(financials({
      operatingMargin: 0.28,
      fundamentalsHistory: {
        ...financials().fundamentalsHistory,
        operatingIncome: [{ year: 2025, value: -120_000 }],
      },
    } as Partial<StockFinancials>));

    assert.equal(w.length, 1);
    assert.match(w[0].message, /opposite signs/);
  });
});

describe('reading a flagged margin', () => {
  it('prefers the fiscal year once the audit has contradicted the trailing figure', async () => {
    // ServiceNow's shape: trailing operating margin 4.1 % against a trailing net
    // margin of 11.3 % and a fiscal year of 13.7 %. The audit flagged it; every
    // consumer used to read the flagged number anyway.
    const { reliableMargin } = await import('../src/analysis/metrics.js');
    const f = financials({
      operatingMargin: 0.041,
      fundamentalsHistory: {
        ...financials().fundamentalsHistory,
        revenue: [{ year: 2025, value: 13_280 }],
        operatingIncome: [{ year: 2025, value: 1_820 }],
      },
    } as Partial<StockFinancials>);
    f.dataQualityWarnings = auditFinancials(f);

    const read = reliableMargin(f, 'operatingMargin');
    assert.equal(read.source, 'statement');
    assert.ok(Math.abs((read.value ?? 0) - 1_820 / 13_280) < 1e-9);
  });

  it('leaves an unflagged margin exactly as reported', async () => {
    const { reliableMargin } = await import('../src/analysis/metrics.js');
    const f = financials();
    f.dataQualityWarnings = auditFinancials(f);
    assert.deepEqual(reliableMargin(f, 'operatingMargin'), { value: 0.10, source: 'reported' });
  });
});
