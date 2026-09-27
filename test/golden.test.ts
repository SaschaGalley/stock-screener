/**
 * Real stocks, priced and scored as they were.
 *
 * Every other test pins one rule on a made-up firm. These pin the whole chain
 * on stored payloads — a megacap, an insurer priced by its excess returns, a
 * euro listing, an ADR reporting in kroner, a firm losing money and one with
 * almost no revenue — so a change anywhere in the models moves a number here,
 * and the diff of the expectation files is what the change did to real stocks.
 *
 *   pnpm run golden:capture -- SYMBOL   # a new fixture from the database
 *   UPDATE_GOLDEN=1 pnpm test           # after an intended change
 *
 * Scored on the explicit ramps: a recalibration is data and is tested as
 * such; it should not rewrite six files of expectations.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { useCalibrationTable } from '../src/analysis/calibration.js';
import { computeAllMetrics } from '../src/analysis/computeMetrics.js';
import { computeFactorScore } from '../src/analysis/score.js';
import type { StoredInputs } from '../src/db/rescore.js';

useCalibrationTable({});

const DIR = join(import.meta.dirname, 'golden');
const UPDATE = !!process.env.UPDATE_GOLDEN;

/** Six significant digits: enough to catch a change, not the last bit of a logarithm. */
const r = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toPrecision(6));

/** What a change to the models could move, in a form whose diff reads. */
function summary(inputs: StoredInputs) {
  const { financials: f, sectorMedians, marketSignals, technicalSignals, rates } = inputs;
  const m = computeAllMetrics(f, rates, sectorMedians);
  const factor = computeFactorScore({ financials: f, metrics: m, sectorMedians, marketSignals, technicalSignals });
  const tier = (t: typeof m.composite.primary) => ({
    median: r(t.median),
    models: Object.fromEntries(t.models.map((x) => [x.name, { value: r(x.fairValue), weight: x.weight ?? 1 }])),
  });
  return {
    price: f.price,
    dcf: {
      fairValue:    r(m.dcf.fairValue),
      p10:          r(m.dcf.distribution?.p10),
      p50:          r(m.dcf.distribution?.p50),
      p90:          r(m.dcf.distribution?.p90),
      aboveprice:   r(m.dcf.distribution?.probabilityAbovePrice),
      wacc:         r(m.dcf.discountRate),
      terminalWacc: r(m.dcf.terminalDiscountRate),
      terminalGrowth: r(m.dcf.terminalGrowthRate),
      targetMargin: r(m.dcf.targetMargin),
      salesToCapital: r(m.dcf.salesToCapital),
    },
    reverseDcf: {
      impliedGrowth:  r(m.reverseDCF.impliedGrowthRate),
      requiredMargin: r(m.reverseDCF.impliedMargin?.requiredMargin),
    },
    models: {
      grahamNumber:  r(m.grahamNumber.grahamNumber),
      grahamRevised: r(m.grahamRevised.fairValue),
      lynch:         r(m.peterLynch.fairValue),
      ddm:           r(m.ddm.fairValue),
      epv:           r(m.epv.fairValue),
      rim:           r(m.rim.fairValue),
      peers:         r(m.peerMultiples.medianFairPrice),
    },
    composite: { primary: tier(m.composite.primary), conservative: tier(m.composite.conservative) },
    health: {
      piotroski: m.piotroski.score ?? null,
      altmanZ:   r(m.altmanZ.score),
      beneish:   r(m.beneish.score),
      coverage:  r(m.interestCoverage.ratio),
    },
    factor: {
      score:      r(factor.score),
      raw:        r(factor.raw),
      verdict:    factor.verdict,
      confidence: r(factor.confidence),
      agreement:  r(factor.agreement),
      pillars:    Object.fromEntries(factor.pillars.map((p) => [p.key, r(p.score)])),
    },
  };
}

const fixtures = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.endsWith('.inputs.json')).sort()
  : [];

describe('golden payloads', () => {
  it('has fixtures to check', () => {
    assert.ok(fixtures.length > 0, `no *.inputs.json in ${DIR}`);
  });

  for (const file of fixtures) {
    const symbol = file.replace(/\.inputs\.json$/, '');
    it(`${symbol} prices and scores as it did`, () => {
      const inputs = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as StoredInputs;
      const actual = summary(inputs);
      const expectedPath = join(DIR, `${symbol}.expected.json`);
      if (UPDATE) {
        writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
        return;
      }
      assert.ok(existsSync(expectedPath), `${symbol}: no expectation — run UPDATE_GOLDEN=1 pnpm test`);
      assert.deepEqual(actual, JSON.parse(readFileSync(expectedPath, 'utf8')));
    });
  }
});
