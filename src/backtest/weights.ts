/**
 * Whether the backtest should move the weights, and whether the move holds up
 * on years it was not fitted on.
 *
 * The backtest measures every criterion's IC anyway, and reading weights off
 * them is the obvious next step — and the classic way to fit a model to its
 * own past: over thirteen years some criterion always did well, and a weight
 * raised on it describes those years, not the next one. So the fit is a fixed
 * rule, and the rule is checked the way a forecast is. It is fitted on the
 * first half of the months and scored on the second against the judgment
 * weights, on exactly the same stocks and months, and then the other way round.
 *
 * The rule, set before any half was looked at:
 *
 *   1. Criteria. Each criterion's IC over one month tilts its judgment weight
 *      (`tiltFor`): shrunk towards zero by its own standard error, under a
 *      prior as wide as the criteria's true ICs are apart — as far as their
 *      measured ones show beyond noise (`priorSdFrom`). Inside each pillar the
 *      criteria then sum to what they did. Criteria that differ by no more than
 *      their noise give a width of zero, and nothing moves.
 *   2. Pillars. The same one level up for the four pillars the backtest can
 *      score, each read with its tilted criteria. Together they keep the share
 *      they had; consensus and revisions, which it cannot score, keep theirs.
 *
 * The fit has held up when the published score's IC improves at one month in
 * both directions and does not fall at three months in the forward one. Only
 * then does `pnpm run backtest -- --write-weights` commit the rule applied to
 * every month (`analysis/weight-table.ts`).
 *
 * The first run (28 September 2026, S&P 500 2013–2026) left every weight
 * where judgment set it. The criteria's squared t-statistics summed to 17.9
 * over twenty criteria, and to 20.4 and 11.8 in the two halves — what twenty
 * criteria without any skill produce — so no prior width survived on all
 * months. The first half alone tilted a little, and on the second that tilt
 * added 0.0006 to the IC.
 */

import {
  evaluate, jointTest, meanTest, priorSdFrom, tiltFor, type Close, type IcSummary, type SignalPoint,
} from '../analysis/evaluate.js';
import {
  assembleScore, JUDGMENT_WEIGHTS, PILLAR_LABELS, type CriterionPoints, type ScoreWeights, type WeightFitMeta,
} from '../analysis/score.js';
import { PILLAR_KEYS, type FactorScore, type PillarKey } from '../types.js';

/**
 * Where the months are halved: 2013–2019 against 2020–2026, seven years
 * against not quite seven. The month-end on the line — December 2019, whose
 * month ahead is January 2020 — belongs to neither half, so no return is
 * read by both.
 */
export const WEIGHT_SPLIT = '2020-01-01';

/** Decimals a fitted weight is kept to: finer than anyone would set one, coarse enough to read. */
const WEIGHT_DECIMALS = 3;

/** Every criterion the judgment weighs, in one fixed order: the layout of `ScoredRow.points`. */
export const CRITERIA: readonly { pillar: PillarKey; key: string }[] = PILLAR_KEYS.flatMap((pillar) =>
  Object.keys(JUDGMENT_WEIGHTS.criteria[pillar]).map((key) => ({ pillar, key })));

const criterionId = (pillar: PillarKey, key: string) => `${pillar}.${key}`;
const INDEX = new Map(CRITERIA.map((c, i) => [criterionId(c.pillar, c.key), i]));

/**
 * One company at one month-end, as much of it as weighing it again takes:
 * each criterion's points (NaN where it abstained) and the trust in its
 * payload. Neither depends on the weights, so a row scores under any of them.
 */
export interface ScoredRow {
  at:     Date;
  symbol: string;
  trust:  number;
  points: Float64Array;
}

export function scoredRow(at: Date, symbol: string, trust: number, factor: Pick<FactorScore, 'pillars'>): ScoredRow {
  const points = new Float64Array(CRITERIA.length).fill(NaN);
  for (const p of factor.pillars) {
    for (const c of p.criteria) {
      const i = INDEX.get(criterionId(p.key, c.key));
      if (i !== undefined && c.points !== null) points[i] = c.points;
    }
  }
  return { at, symbol, trust, points };
}

function criteriaOf(row: ScoredRow): Record<PillarKey, CriterionPoints[]> {
  const out = Object.fromEntries(PILLAR_KEYS.map((p) => [p, [] as CriterionPoints[]])) as Record<PillarKey, CriterionPoints[]>;
  CRITERIA.forEach((c, i) => {
    const v = row.points[i];
    out[c.pillar].push({ key: c.key, points: Number.isNaN(v) ? null : v });
  });
  return out;
}

type Signals = Map<string, Map<string, SignalPoint[]>>;

function push(signals: Signals, key: string, symbol: string, point: SignalPoint): void {
  let bySymbol = signals.get(key);
  if (!bySymbol) signals.set(key, bySymbol = new Map());
  const list = bySymbol.get(symbol);
  if (list) list.push(point); else bySymbol.set(symbol, [point]);
}

/** One weight the fit set: a criterion's, or with `key` null the pillar's own. */
export interface FittedWeight {
  pillar:      PillarKey;
  key:         string | null;
  label:       string;
  judgment:    number;
  fitted:      number;
  /** IC over the fit's months at its horizon; null where the backtest could not measure it. */
  ic:          number | null;
  se:          number | null;
  independent: number;
}

export interface Fit {
  /** The months whose returns the fit read. */
  from:    string | null;
  to:      string | null;
  months:  number;
  weights: ScoreWeights;
  rows:    FittedWeight[];
  /** The prior widths the tilts used, criteria and pillars; zero where a level moved nowhere. */
  priorSd: { criteria: number; pillars: number };
  /** Whether each level ranks anything at all, taken together (`jointTest`). */
  joint:   { criteria: { sumT2: number; k: number }; pillars: { sumT2: number; k: number } };
  /** Whether any weight came out different from the judgment's. */
  moved:   boolean;
}

export interface ScoreIc {
  ic:        number | null;
  tStat:     number | null;
  neutralIc: number | null;
}

/** The published score under the judgment weights and under a fit, on the same months. */
export interface Comparison {
  horizon:     number;
  months:      number;
  independent: number;
  judgment:    ScoreIc;
  fitted:      ScoreIc;
  /** Fitted minus judgment IC over the independent windows, and the share of them it was ahead in. */
  gain:        { mean: number | null; se: number | null; tStat: number | null; ahead: number | null };
}

export interface Fold {
  fit:         Fit;
  /** The months the fit was scored on — none of which it read. */
  tested:      { from: string | null; to: string | null };
  comparisons: Comparison[];
}

export interface WeightValidation {
  split:   string;
  /** The horizon the fit reads. */
  horizon: number;
  /** Fitted on the first half, scored on the second. */
  forward: Fold;
  /** Fitted on the second half, scored on the first. */
  reverse: Fold;
  /** The rule on every month: what `--write-weights` commits once the check has held. */
  full:    Fit;
  held:    boolean;
}

/**
 * Weights tilted by their ICs. The measured ones keep the total they had
 * between them, the unmeasured ones are left as they were, and a tilt that
 * would remove every measured weight is no tilt.
 */
function tilted(
  base: Readonly<Record<string, number>>, statOf: (key: string) => IcSummary | undefined, tau: number,
): Record<string, number> {
  const keys = Object.keys(base);
  const measured = keys.filter((k) => statOf(k));
  const before = measured.reduce((a, k) => a + base[k], 0);
  const raw = new Map(measured.map((k) => {
    const s = statOf(k)!;
    return [k, base[k] * tiltFor(s.meanIc!, s.se!, tau)] as const;
  }));
  const after = [...raw.values()].reduce((a, w) => a + w, 0);
  if (!(after > 0)) return { ...base };
  return rounded(Object.fromEntries(keys.map((k) => [k, raw.has(k) ? raw.get(k)! * before / after : base[k]])), before, measured);
}

/**
 * Weights kept to `WEIGHT_DECIMALS`, with what the rounding lost or gained put
 * on the largest of `adjustable` so that they still add up to `total` —
 * pillar weights must sum to exactly one for the coverage to read as a share.
 */
function rounded(weights: Record<string, number>, total: number, adjustable: string[]): Record<string, number> {
  const f = 10 ** WEIGHT_DECIMALS;
  const out = Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, Math.round(w * f) / f]));
  const largest = adjustable.reduce<string | null>((best, k) => (best === null || out[k] > out[best] ? k : best), null);
  if (largest !== null) {
    const residual = total - adjustable.reduce((a, k) => a + out[k], 0);
    out[largest] = Math.round((out[largest] + residual) * f) / f;
  }
  return out;
}

const measuredOnly = (r: IcSummary) => r.meanIc !== null && r.se !== null;

/**
 * The fitting and the checking, over one backtest's rows.
 *
 * The rows are read once into one signal per criterion; everything after that
 * is the same rows weighed again, and `evaluate` run over whichever months a
 * step is allowed to see.
 */
export function weightLab(
  rows: ScoredRow[],
  market: { prices: Map<string, Close[]>; sectors: Map<string, string> },
  opts: { fitHorizon: number; horizons: number[]; labels?: Map<string, string> },
) {
  const byCriterion: Signals = new Map();
  for (const r of rows) {
    CRITERIA.forEach((c, i) => {
      const v = r.points[i];
      if (!Number.isNaN(v)) push(byCriterion, criterionId(c.pillar, c.key), r.symbol, { at: r.at, value: v });
    });
  }

  /** The rows as scored under `weights`: the published score, and each pillar when asked for. */
  const under = (weights: ScoreWeights, prefix: string, pillars: boolean): Signals => {
    const out: Signals = new Map();
    for (const r of rows) {
      const a = assembleScore(criteriaOf(r), r.trust, weights);
      push(out, `${prefix}score`, r.symbol, { at: r.at, value: a.score });
      if (pillars) {
        for (const p of a.pillars) if (p.score !== null) push(out, `${prefix}pillar.${p.key}`, r.symbol, { at: r.at, value: p.score });
      }
    }
    return out;
  };

  const ics = (signals: Signals, calendar: Close[], horizons: number[], neutral = false) => evaluate({
    signals, prices: market.prices, benchmark: calendar, horizons,
    sectors: neutral ? market.sectors : undefined, keepDaily: neutral,
  }).ics;

  function fit(calendar: Close[], base: ScoreWeights = JUDGMENT_WEIGHTS): Fit {
    const h = opts.fitHorizon;

    const criterionIcs = ics(byCriterion, calendar, [h]);
    const byId = new Map(criterionIcs.filter(measuredOnly).map((r) => [r.key, r]));
    const criterionStats = [...byId.values()].map((r) => ({ ic: r.meanIc!, se: r.se! }));
    const tauCriteria = priorSdFrom(criterionStats);
    const criteria = Object.fromEntries(PILLAR_KEYS.map((p) => [
      p, tilted(base.criteria[p], (key) => byId.get(criterionId(p, key)), tauCriteria),
    ])) as Record<PillarKey, Record<string, number>>;

    const pillarIcs = ics(under({ pillars: base.pillars, criteria }, '', true), calendar, [h])
      .filter((r) => r.key.startsWith('pillar.'));
    const byPillar = new Map(pillarIcs.filter(measuredOnly).map((r) => [r.key.slice('pillar.'.length), r]));
    const pillarStats = [...byPillar.values()].map((r) => ({ ic: r.meanIc!, se: r.se! }));
    const tauPillars = priorSdFrom(pillarStats);
    const pillars = tilted(base.pillars, (key) => byPillar.get(key), tauPillars) as Record<PillarKey, number>;

    const row = (pillar: PillarKey, key: string | null, judgment: number, fitted: number, r: IcSummary | undefined): FittedWeight => ({
      pillar, key,
      label: key === null ? PILLAR_LABELS[pillar] : opts.labels?.get(criterionId(pillar, key)) ?? key,
      judgment, fitted, ic: r?.meanIc ?? null, se: r?.se ?? null, independent: r?.independent ?? 0,
    });
    const rows = PILLAR_KEYS.flatMap((p) => [
      row(p, null, base.pillars[p], pillars[p], byPillar.get(p)),
      ...Object.keys(base.criteria[p]).map((k) => row(p, k, base.criteria[p][k], criteria[p][k], byId.get(criterionId(p, k)))),
    ]);
    return {
      from:    calendar[0]?.date ?? null,
      to:      calendar[calendar.length - 1]?.date ?? null,
      months:  Math.max(0, ...criterionIcs.map((r) => r.days)),
      weights: { pillars, criteria },
      rows,
      priorSd: { criteria: tauCriteria, pillars: tauPillars },
      joint:   { criteria: jointTest(criterionStats), pillars: jointTest(pillarStats) },
      moved:   rows.some((r) => Math.abs(r.fitted - r.judgment) >= 0.5 * 10 ** -WEIGHT_DECIMALS),
    };
  }

  function compare(calendar: Close[], fitted: ScoreWeights, base: ScoreWeights = JUDGMENT_WEIGHTS): Comparison[] {
    const all = ics(new Map([...under(base, 'judgment.', false), ...under(fitted, 'fitted.', false)]), calendar, opts.horizons, true);
    return opts.horizons.map((h) => {
      const a = all.find((r) => r.key === 'judgment.score' && r.horizon === h);
      const b = all.find((r) => r.key === 'fitted.score' && r.horizon === h);
      const before = new Map((a?.daily ?? []).map((d) => [d.day, d.ic]));
      // Windows `h` months long overlap unless every h-th is taken, as `evaluate` does for its t.
      const gains = (b?.daily ?? []).flatMap((d) => (before.has(d.day) ? [d.ic - before.get(d.day)!] : []))
        .filter((_, i) => i % h === 0);
      const test = meanTest(gains);
      const scoreIc = (r: IcSummary | undefined): ScoreIc => ({ ic: r?.meanIc ?? null, tStat: r?.tStat ?? null, neutralIc: r?.neutralIc ?? null });
      return {
        horizon: h,
        months: b?.days ?? 0,
        independent: gains.length,
        judgment: scoreIc(a),
        fitted: scoreIc(b),
        gain: {
          mean:  gains.length ? gains.reduce((s, g) => s + g, 0) / gains.length : null,
          se:    test.se,
          tStat: test.t,
          ahead: gains.length ? gains.filter((g) => g > 0).length / gains.length : null,
        },
      };
    });
  }

  function validate(calendar: Close[], split: string = WEIGHT_SPLIT): WeightValidation {
    const first = calendar.filter((c) => c.date < split);
    const second = calendar.filter((c) => c.date >= split);
    const fold = (fitOn: Close[], testOn: Close[]): Fold => {
      const f = fit(fitOn);
      return {
        fit: f,
        tested: { from: testOn[0]?.date ?? null, to: testOn[testOn.length - 1]?.date ?? null },
        comparisons: compare(testOn, f.weights),
      };
    };
    const forward = fold(first, second);
    const reverse = fold(second, first);
    const gain = (f: Fold, h: number) => f.comparisons.find((c) => c.horizon === h)?.gain.mean ?? null;
    const h = opts.fitHorizon;
    const held = (gain(forward, h) ?? 0) > 0 && (gain(reverse, h) ?? 0) > 0
      && opts.horizons.filter((x) => x !== h).every((x) => (gain(forward, x) ?? -1) >= 0);
    return { split, horizon: h, forward, reverse, full: fit(calendar), held };
  }

  return { fit, compare, validate };
}

// ── The committed fit ────────────────────────────────────────────────────────

const pts = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(4)}`);

/** `analysis/weight-table.ts` for a fit that held up: the pillars and criteria the backtest measured. */
export function renderWeightTable(v: WeightValidation, meta: WeightFitMeta): string {
  const measured = PILLAR_KEYS.filter((p) => v.full.rows.some((r) => r.pillar === p && r.ic !== null));
  const gainLine = (name: string, f: Fold) => f.comparisons.map((c) =>
    `// ${name} (fitted ${f.fit.from} → ${f.fit.to}, scored ${f.tested.from} → ${f.tested.to}), ${c.horizon} month${c.horizon > 1 ? 's' : ''}: `
    + `IC ${pts(c.judgment.ic)} → ${pts(c.fitted.ic)}, gain ${pts(c.gain.mean)} (t ${c.gain.tStat?.toFixed(1) ?? '—'})`);
  const obj = (o: Record<string, number>) => `{ ${Object.entries(o).map(([k, w]) => `${JSON.stringify(k)}: ${w}`).join(', ')} }`;
  return [
    '// Generated by `pnpm run backtest -- --write-weights` (src/backtest/run.ts) — do not edit by hand.',
    `// The judgment weights in score.ts, tilted by ${meta.months} month-ends of the backtest (${meta.from} → ${meta.to},`,
    `// ${meta.companies} companies); prior widths ${v.full.priorSd.criteria.toFixed(4)} (criteria) and ${v.full.priorSd.pillars.toFixed(4)} (pillars).`,
    '// Checked on the half of the months each fit had not seen:',
    ...gainLine('Forward', v.forward),
    ...gainLine('Reverse', v.reverse),
    '',
    "import type { FittedWeights, WeightFitMeta } from './score.js';",
    '',
    `export const FITTED_WEIGHTS_META: WeightFitMeta | null = ${JSON.stringify(meta)};`,
    '',
    'export const FITTED_WEIGHTS: FittedWeights | null = {',
    `  pillars: ${obj(Object.fromEntries(measured.map((p) => [p, v.full.weights.pillars[p]])))},`,
    '  criteria: {',
    ...measured.map((p) => `    ${p}: ${obj(v.full.weights.criteria[p])},`),
    '  },',
    '};',
    '',
  ].join('\n');
}
