/**
 * The archive, read back: analysts' track record, the income statement as a
 * flow, and the timeline's own events.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitFactorAfter, targetOutcomes, trackRecord, type AnalystAction } from '../src/analysis/analyst-accuracy.js';
import { flowFromRow, flowLinks, ttmFlow } from '../src/analysis/income-flow.js';
import { analystEvent, bigMoves } from '../src/analysis/timeline.js';

/** Two years of daily bars rising from 100 by 0.1 a day. */
const bars = Array.from({ length: 730 }, (_, k) => ({
  day: new Date(Date.UTC(2023, 0, 1) + k * 86_400_000).toISOString().slice(0, 10),
  close: 100 + k * 0.1,
}));
const action = (over: Partial<AnalystAction>): AnalystAction => ({
  gradedAt: '2023-01-01T12:00:00Z', firm: 'Firm A', action: 'main', fromGrade: 'Buy', toGrade: 'Buy',
  priceTargetAction: 'Raises', priceTarget: 120, priorPriceTarget: 110, ...over,
});

describe('the analysts track record', () => {
  it('scores a target against the price a year later', () => {
    const [o] = targetOutcomes([action({})], bars, []);
    // Price 100 then, about 136.5 a year later: the 120 target was reached and beaten.
    assert.ok(Math.abs(o.implied - 0.2) < 1e-9);
    assert.equal(o.reached, true);
    assert.equal(o.direction, true);
    assert.ok(o.error! > 0.1);
  });

  it('puts a pre-split target on today\'s basis', () => {
    assert.equal(splitFactorAfter([{ day: '2023-06-01', ratio: 4 }], '2023-01-01'), 4);
    const [o] = targetOutcomes([action({ priceTarget: 480 })], bars, [{ day: '2023-06-01', ratio: 4 }]);
    assert.equal(o.target, 120, 'a $480 target before a 4:1 split is $120 now');
  });

  it('leaves a target whose year is still running without an outcome', () => {
    const [o] = targetOutcomes([action({ gradedAt: '2024-06-01T00:00:00Z' })], bars, []);
    assert.equal(o.error, null);
    assert.equal(trackRecord([action({ gradedAt: '2024-06-01T00:00:00Z' })], bars, []).overall.n, 0);
  });

  it('builds the consensus from each firm\'s newest target', () => {
    const r = trackRecord([
      action({ firm: 'A', priceTarget: 110, gradedAt: '2023-01-05T00:00:00Z' }),
      action({ firm: 'A', priceTarget: 130, gradedAt: '2023-02-05T00:00:00Z' }),
      action({ firm: 'B', priceTarget: 150, gradedAt: '2023-02-10T00:00:00Z' }),
    ], bars, []);
    const feb = r.consensus.find((p) => p.day.startsWith('2023-02'))!;
    assert.equal(feb.target, 140);
    assert.equal(feb.firms, 2);
  });
});

describe('the income statement as a flow', () => {
  const row = {
    date: '2025-09-30T00:00:00.000Z', totalRevenue: 1000, costOfRevenue: 600, researchAndDevelopment: 100,
    sellingGeneralAndAdministration: 150, operatingIncome: 120, pretaxIncome: 130, taxProvision: 20, netIncome: 110,
  };

  it('reads the stages and names what the lines do not explain', () => {
    const f = flowFromRow(row, 'annual')!;
    assert.equal(f.grossProfit, 400);
    assert.equal(f.otherOperating, 30);
    assert.equal(f.nonOperating, 10);
    const links = flowLinks(f);
    const out = (s: string) => links.filter((l) => l.source === s).reduce((a, l) => a + l.value, 0);
    const into = (t: string) => links.filter((l) => l.target === t).reduce((a, l) => a + l.value, 0);
    assert.equal(out('Bruttogewinn'), into('Bruttogewinn'), 'gross profit balances');
    assert.equal(into('Nettoergebnis'), 110);
  });

  it('draws an operating loss covered by other income as a shortfall, not a negative stream', () => {
    const f = flowFromRow({ ...row, operatingIncome: -200, pretaxIncome: 100, taxProvision: -20, netIncome: 120 }, 'annual')!;
    const links = flowLinks(f);
    assert.ok(links.every((l) => l.value > 0));
    assert.ok(links.some((l) => l.source === 'Operativer Verlust' && l.target === 'Bruttogewinn' && l.value === 200));
    assert.ok(links.some((l) => l.source === 'Finanz- & Sonstiges' && l.target === 'Operativer Verlust' && l.value === 200));
    assert.ok(links.some((l) => l.source === 'Steuergutschrift' && l.value === 20));
  });

  it('sums four consecutive quarters, and refuses a gap', () => {
    const q = (m: string) => ({ ...row, date: `${m}T00:00:00.000Z`, totalRevenue: 250 });
    assert.equal(ttmFlow([q('2025-03-31'), q('2025-06-30'), q('2025-09-30'), q('2025-12-31')])!.revenue, 1000);
    assert.equal(ttmFlow([q('2024-03-31'), q('2025-06-30'), q('2025-09-30'), q('2025-12-31')]), null);
  });
});

describe('the timeline', () => {
  const money = (n: number) => `$${n}`;

  it('lists a reiteration only when the target moved', () => {
    assert.equal(analystEvent(action({ action: 'reit', priceTarget: 120, priorPriceTarget: 120 }), money), null);
    const e = analystEvent(action({ action: 'main', priceTarget: 100, priorPriceTarget: 120 }), money)!;
    assert.equal(e.tone, 'negative');
    assert.match(e.detail!, /\$120 → \$100/);
  });

  it('flags a day far outside the stock\'s usual range', () => {
    const quiet = Array.from({ length: 300 }, (_, k) => ({ day: `2025-${String(1 + Math.floor(k / 28)).padStart(2, '0')}-${String(1 + (k % 28)).padStart(2, '0')}`, close: 100 + (k % 2) * 0.5 }));
    quiet.push({ day: '2025-12-30', close: 115 });
    const moves = bigMoves(quiet, '2025-01-01');
    assert.equal(moves.length, 1);
    assert.equal(moves[0].day, '2025-12-30');
  });
});
