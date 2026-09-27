/**
 * Weights that the backtest may move, and the check that decides whether it may.
 *
 * The scorer's arithmetic is split so that the same criteria can be weighed
 * twice; that split must not move a single score. The fit must find a signal
 * that is there, keep the totals the rest of the scorer relies on, and a
 * signal planted in the months it fits must still pay in the months it has
 * not seen.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { useCalibrationTable } from '../src/analysis/calibration.js';
import { computeAllMetrics } from '../src/analysis/computeMetrics.js';
import { priorSdFrom, tiltFor, type Close } from '../src/analysis/evaluate.js';
import {
  assembleScore, computeFactorScore, JUDGMENT_WEIGHTS, trustOf, WEIGHTS, withFitted,
} from '../src/analysis/score.js';
import { FITTED_WEIGHTS } from '../src/analysis/weight-table.js';
import { CRITERIA, renderWeightTable, weightLab, type ScoredRow } from '../src/backtest/weights.js';
import type { StoredInputs } from '../src/db/rescore.js';
import { PILLAR_KEYS } from '../src/types.js';

const sum = (o: Readonly<Record<string, number>>) => Object.values(o).reduce((a, b) => a + b, 0);

describe('the weights', () => {
  it('sum to one across the pillars and inside each, as judged and as in force', () => {
    for (const w of [JUDGMENT_WEIGHTS, WEIGHTS]) {
      assert.ok(Math.abs(sum(w.pillars) - 1) < 1e-9);
      for (const p of PILLAR_KEYS) assert.ok(Math.abs(sum(w.criteria[p]) - 1) < 1e-9, p);
    }
  });

  it('fit only criteria the judgment weighs', () => {
    for (const [p, table] of Object.entries(FITTED_WEIGHTS?.criteria ?? {})) {
      for (const key of Object.keys(table ?? {})) {
        assert.ok(key in JUDGMENT_WEIGHTS.criteria[p as keyof typeof JUDGMENT_WEIGHTS.criteria], `${p}.${key}`);
      }
    }
  });

  it('lay a fit over the judgment and leave the rest as it was', () => {
    const w = withFitted(JUDGMENT_WEIGHTS, { pillars: { valuation: 0.4, health: 0.05 }, criteria: { quality: { 'net-issuance': 0.3 } } });
    assert.equal(w.pillars.valuation, 0.4);
    assert.equal(w.pillars.consensus, JUDGMENT_WEIGHTS.pillars.consensus);
    assert.equal(w.criteria.quality['net-issuance'], 0.3);
    assert.equal(w.criteria.quality.piotroski, JUDGMENT_WEIGHTS.criteria.quality.piotroski);
  });
});

describe('weighing the same criteria again', () => {
  useCalibrationTable({});
  const inputs = JSON.parse(readFileSync(join(import.meta.dirname, 'golden', 'MSFT.inputs.json'), 'utf8')) as StoredInputs;
  const { financials: f, sectorMedians, marketSignals, technicalSignals, rates } = inputs;
  const m = computeAllMetrics(f, rates, sectorMedians);
  const factor = computeFactorScore({ financials: f, metrics: m, sectorMedians, marketSignals, technicalSignals });
  const criteria = Object.fromEntries(factor.pillars.map((p) => [p.key, p.criteria])) as unknown as Parameters<typeof assembleScore>[0];

  it('gives the score the scorer gave', () => {
    const a = assembleScore(criteria, trustOf(f, m));
    assert.equal(a.score, factor.score);
    assert.equal(a.raw, factor.raw);
  });

  it('moves the raw score when a criterion is weighed differently', () => {
    const quality = factor.pillars.find((p) => p.key === 'quality')!;
    const top = [...quality.criteria].filter((c) => c.points !== null).sort((x, y) => y.points! - x.points!)[0];
    const heavier = withFitted(WEIGHTS, { pillars: {}, criteria: { quality: { [top.key]: 5 } } });
    assert.ok(assembleScore(criteria, trustOf(f, m), heavier).raw > factor.raw, `more weight on ${top.key}`);
  });

  it('refuses a criterion the table does not weigh', () => {
    const extra = { ...criteria, quality: [...criteria.quality, { key: 'unlisted', points: 1 }] };
    assert.throws(() => assembleScore(extra, 1), /quality\.unlisted/);
  });
});

describe('the tilt', () => {
  it('moves nothing without a prior width', () => {
    assert.equal(tiltFor(0.05, 0.01, 0), 1);
  });

  it('doubles a weight at one prior width of skill and removes it at minus one', () => {
    assert.equal(tiltFor(0.02, 0, 0.02), 2);
    assert.equal(tiltFor(-0.02, 0, 0.02), 0);
    assert.ok(tiltFor(0.02, 0.02, 0.02) < 2, 'less when the IC is as uncertain as the prior is wide');
  });

  it('reads the prior width from how far apart the ICs are beyond their noise', () => {
    assert.equal(priorSdFrom([{ ic: 0.01, se: 0.01 }, { ic: -0.01, se: 0.01 }, { ic: 0.005, se: 0.01 }]), 0);
    const tau = priorSdFrom([{ ic: 0.05, se: 0.01 }, { ic: -0.05, se: 0.01 }, { ic: 0.05, se: 0.01 }]);
    assert.ok(Math.abs(tau - Math.sqrt(0.05 ** 2 - 0.01 ** 2)) < 1e-12);
    assert.equal(priorSdFrom([{ ic: 0.05, se: 0.01 }, { ic: 0.05, se: 0.01 }]), 0, 'two ICs estimate nothing');
  });
});

describe('fitting and checking on unseen months', () => {
  // A deterministic generator, so the planted signal is the same on every run.
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());

  const months: string[] = [];
  for (let y = 2013; y <= 2026; y++) {
    for (let mo = 1; mo <= 12; mo++) months.push(new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10));
  }
  const signal = CRITERIA.findIndex((c) => c.pillar === 'quality' && c.key === 'net-issuance');
  const symbols = Array.from({ length: 60 }, (_, i) => `S${i}`);
  const rows: ScoredRow[] = [];
  const prices = new Map<string, Close[]>(symbols.map((s) => [s, [{ date: months[0], close: 100 }]]));
  months.forEach((day, t) => {
    for (const s of symbols) {
      // Analyst data was never archived: the backtest's consensus and revisions criteria always abstain.
      const points = new Float64Array(CRITERIA.length).map((_, i) =>
        (CRITERIA[i].pillar === 'consensus' || CRITERIA[i].pillar === 'revisions' ? NaN : random()));
      // Only this criterion knows anything about the month ahead.
      const closes = prices.get(s)!;
      if (t + 1 < months.length) {
        const r = 0.03 * (points[signal] - 0.5) + 0.02 * normal();
        closes.push({ date: months[t + 1], close: closes[closes.length - 1].close * (1 + r) });
      }
      rows.push({ at: new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000), symbol: s, trust: 1, points });
    }
  });
  const calendar: Close[] = months.map((date) => ({ date, close: 100 }));
  const lab = weightLab(rows, { prices, sectors: new Map(symbols.map((s, i) => [s, `Sector ${i % 4}`])) }, {
    fitHorizon: 1, horizons: [1, 3],
  });
  const v = lab.validate(calendar, '2020-01-01');

  it('finds the criterion that knows something and gives it weight', () => {
    const w = v.full.weights.criteria.quality;
    assert.ok(w['net-issuance'] > 2 * JUDGMENT_WEIGHTS.criteria.quality['net-issuance'], `net issuance ${w['net-issuance']}`);
    assert.ok(v.full.weights.pillars.quality > JUDGMENT_WEIGHTS.pillars.quality, 'and its pillar');
  });

  it('keeps the totals: pillars to one, each pillar\'s criteria to one, unmeasured pillars untouched', () => {
    assert.ok(Math.abs(sum(v.full.weights.pillars) - 1) < 1e-9);
    for (const p of PILLAR_KEYS) assert.ok(Math.abs(sum(v.full.weights.criteria[p]) - 1) < 1e-9, p);
    assert.equal(v.full.weights.pillars.consensus, JUDGMENT_WEIGHTS.pillars.consensus);
    assert.deepEqual(v.full.weights.criteria.revisions, JUDGMENT_WEIGHTS.criteria.revisions);
  });

  it('holds up on the half of the months each fit did not read', () => {
    for (const fold of [v.forward, v.reverse]) {
      const oneMonth = fold.comparisons.find((c) => c.horizon === 1)!;
      assert.ok((oneMonth.gain.mean ?? 0) > 0, `gain ${oneMonth.gain.mean}`);
      assert.ok(fold.fit.to! < fold.tested.from! || fold.tested.to! < fold.fit.from!, 'fitted and scored months do not meet');
    }
    assert.equal(v.held, true);
  });

  it('writes a table with the pillars it measured and nothing else', () => {
    const table = renderWeightTable(v, { generatedAt: '2026-09-28T00:00:00.000Z', from: months[0], to: months[months.length - 1], months: 164, companies: 60 });
    assert.match(table, /export const FITTED_WEIGHTS: FittedWeights \| null = \{/);
    assert.match(table, /quality: \{ "piotroski": /);
    assert.doesNotMatch(table, /consensus:|revisions:/);
  });
});
