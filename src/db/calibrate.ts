/**
 * Find every calibrated criterion's neutral point in the stored history.
 *
 *   pnpm run calibrate                     # writes src/analysis/calibration-table.ts
 *   pnpm run calibrate -- --weeks 26       # how far back to sample (default 26)
 *   pnpm run calibrate -- --out /tmp/t.ts  # somewhere else
 *   node dist/db/calibrate.js --store      # into the database, for the admin page to offer
 *
 * `--store` is how a deployment calibrates: its image has no sources to write
 * into and no repository to commit to, but its database is the one with the
 * universe in it. The table goes to `app_state` as a proposal, with what it
 * would move (`compareTables`), and the admin page offers it as the file to
 * commit (`calibration-service.ts`).
 *
 * Scores every stored symbol — the watchlist and the reference universe alike —
 * at one instant per week, collects each calibrated figure as the scorer reads
 * it (`collectCalibrated`), and writes the 101 percentiles of each. Every symbol
 * contributes at most one instant per week, so a stock that has been stored for
 * longer counts for longer, but a busy week of refreshes does not count more
 * than a quiet one.
 *
 * First, though, it measures the model's premium adjustments: for every stock,
 * the shift of the market premium at which the model that carries it — the
 * DCF, or a lender's excess return model — equals the price, and the median of
 * those shifts in each group of stocks (`premiumTable`, `modelPremiumAdjustment`).
 * The distributions are then collected with those adjustments in force, since
 * the DCF's probability above the price moves with them.
 *
 * The output is code: reviewed, committed, and a change to it re-scores the
 * history like any other scoring change. Figures come from the payloads, never
 * from returns, so calibrating does not fit the score to what happened next.
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';

import { getConfig } from '../config.js';
import { computeAllMetrics, impliedPremiumShift } from '../analysis/computeMetrics.js';
import {
  CALIBRATION_META, collectCalibrated, CriterionDistribution, percentileIn, percentiles, premiumTable, sectorKey,
  usePremiumAdjustment, type CalibrationTable, type PremiumAdjustments, type PremiumPoint,
} from '../analysis/calibration.js';
import { borrowsToLend } from '../analysis/dcf.js';
import { CALIBRATION } from '../analysis/calibration-table.js';
import { computeFactorScore } from '../analysis/score.js';
import { StockFinancials } from '../types.js';
import { logger } from '../utils/logger.js';
import { closePool, waitForDatabase } from './client.js';
import { writeAppState } from './admin.js';
import { storedInputs } from './rescore.js';
import { listSymbols, snapshotHistory } from './store.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The newest financials snapshot of each week, going back `weeks`. */
async function weeklyInstants(symbol: string, weeks: number): Promise<number[]> {
  const since = new Date(Date.now() - weeks * WEEK_MS);
  const history = await snapshotHistory<StockFinancials>(symbol, 'financials', since);
  const byWeek = new Map<number, number>();
  for (const row of history) {
    const t = row.capturedAt.getTime();
    byWeek.set(Math.floor(t / WEEK_MS), t);
  }
  return [...byWeek.values()].sort((a, b) => a - b);
}

/** Rounded to a twentieth of a point: finer is noise, and the number is read by people. */
const roundPremium = (x: number) => Number((Math.round(x / 0.0005) * 0.0005).toFixed(4));

/** The median shift of each group over every stored stock's newest inputs, and how many stocks each rests on. */
export async function impliedPremiumAdjustment(): Promise<{
  adjustments: PremiumAdjustments; groups: ReturnType<typeof premiumTable>['groups'];
} | null> {
  const points: PremiumPoint[] = [];
  for (const symbol of await listSymbols('all')) {
    const inputs = await storedInputs(symbol);
    if (!inputs) continue;
    const shift = impliedPremiumShift(inputs);
    if (shift !== null) {
      points.push({ currency: inputs.financials.tradingCurrency, lender: borrowsToLend(inputs.financials), shift });
    }
  }
  const { adjustments, groups } = premiumTable(points);
  if (Object.keys(adjustments).length === 0) return null;
  return { adjustments: Object.fromEntries(Object.entries(adjustments).map(([k, v]) => [k, roundPremium(v)])), groups };
}

export async function calibrate(weeks: number): Promise<{
  table: Record<string, CriterionDistribution>; symbols: number; observations: number;
}> {
  const symbols = await listSymbols('all');
  const byKey = new Map<string, { values: number[]; symbols: Set<string> }>();
  let observations = 0;
  let scoredSymbols = 0;

  for (const symbol of symbols) {
    const instants = await weeklyInstants(symbol, weeks);
    let scored = false;
    for (const at of instants) {
      const inputs = await storedInputs(symbol, at);
      if (!inputs) continue;
      // A figure read within its sector joins both its sector's distribution
      // and the market's, which a thin sector falls back to.
      const add = (key: string, value: number) => {
        const entry = byKey.get(key) ?? { values: [], symbols: new Set<string>() };
        entry.values.push(value);
        entry.symbols.add(symbol);
        byKey.set(key, entry);
      };
      collectCalibrated((key, value, sector) => {
        add(key, value);
        if (sector) add(sectorKey(key, sector), value);
      }, () => computeFactorScore({
        financials:       inputs.financials,
        metrics:          computeAllMetrics(inputs.financials, inputs.rates, inputs.sectorMedians),
        sectorMedians:    inputs.sectorMedians,
        marketSignals:    inputs.marketSignals,
        technicalSignals: inputs.technicalSignals,
      }));
      observations++;
      scored = true;
    }
    if (scored) scoredSymbols++;
  }

  const table: Record<string, CriterionDistribution> = {};
  for (const [key, { values, symbols: from }] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    table[key] = { quantiles: percentiles(values).map((q) => Number(q.toPrecision(6))), n: values.length, symbols: from.size };
  }
  return { table, symbols: scoredSymbols, observations };
}

/** Where the admin page finds the newest proposal and the state of the run making one. */
export const PROPOSAL_KEY = 'calibration.proposal';
export const STATUS_KEY = 'calibration.status';

export interface CalibrationStatus {
  state:      'running' | 'done' | 'failed' | 'interrupted';
  startedAt:  string;
  finishedAt: string | null;
  error:      string | null;
}

/** One criterion whose typical stock moved: where the new median sits in the old distribution, 0–1. */
export interface CriterionShift { key: string; oldPercentile: number; symbols: number }

/** A generated table, waiting to be committed. */
export interface CalibrationProposal {
  generatedAt:       string;
  weeks:             number;
  symbols:           number;
  observations:      number;
  criteria:          number;
  premiumAdjustments: PremiumAdjustments;
  /** The committed table it would replace, as the image running it has it. */
  current:           { generatedAt: string | null; symbols: number; observations: number; premiumAdjustments: PremiumAdjustments; criteria: number };
  /** Market-wide criteria (no sector keys) whose median moved most, furthest first. */
  shifts:            CriterionShift[];
  /** Keys the new table has and the old lacks, and the other way round. */
  added:             number;
  removed:           number;
  /** The file itself: `src/analysis/calibration-table.ts`. */
  source:            string;
}

/**
 * What a new table would move: for each market-wide criterion, where the new
 * typical stock sits on the old scale. 0.5 is no change; 0.62 means the stock
 * that is typical now would have read as the 62nd percentile before — the
 * criterion's neutral point has risen, and every stock on it scores lower.
 */
export function compareTables(old: CalibrationTable, next: Record<string, CriterionDistribution>, keep = 8): {
  shifts: CriterionShift[]; added: number; removed: number;
} {
  const shifts: CriterionShift[] = [];
  for (const [key, d] of Object.entries(next)) {
    const before = old[key];
    if (!before || key.includes('@')) continue;
    shifts.push({ key, oldPercentile: percentileIn(before.quantiles, d.quantiles[50]), symbols: d.symbols });
  }
  shifts.sort((a, b) => Math.abs(b.oldPercentile - 0.5) - Math.abs(a.oldPercentile - 0.5));
  return {
    shifts: shifts.slice(0, keep),
    added: Object.keys(next).filter((k) => !old[k]).length,
    removed: Object.keys(old).filter((k) => !next[k]).length,
  };
}

function render(
  result: Awaited<ReturnType<typeof calibrate>>, weeks: number,
  premium: Awaited<ReturnType<typeof impliedPremiumAdjustment>>,
): string {
  const lines = [
    '// Generated by `pnpm run calibrate` (src/db/calibrate.ts) — do not edit by hand.',
    `// ${result.symbols} symbols, ${result.observations} weekly observations over the last ${weeks} weeks.`,
    ...(premium
      ? ['// Premium adjustments by group (currency|firm or lender), the median shift at which the model carrying',
        '// each stock prices it:',
        ...Object.entries(premium.groups).map(([key, g]) => `//   ${key.padEnd(12)} ${(premium.adjustments[key] * 100).toFixed(2).padStart(6)} points `
          + `from ${g.stocks} stocks, interquartile range ${(g.iqr[0] * 100).toFixed(2)} to ${(g.iqr[1] * 100).toFixed(2)}.`)]
      : ['// No premium adjustment: too few stocks to measure one.']),
    '',
    "import type { CalibrationTable, PremiumAdjustments } from './calibration.js';",
    '',
    'export const CALIBRATION_META = {',
    `  generatedAt: ${JSON.stringify(new Date().toISOString())} as string | null,`,
    `  symbols: ${result.symbols},`,
    `  observations: ${result.observations},`,
    `  premiumAdjustments: ${JSON.stringify(premium?.adjustments ?? {})} as PremiumAdjustments,`,
    '} as const;',
    '',
    'export const CALIBRATION: CalibrationTable = {',
  ];
  for (const [key, d] of Object.entries(result.table)) {
    lines.push(`  ${JSON.stringify(key)}: {`);
    lines.push(`    n: ${d.n}, symbols: ${d.symbols},`);
    lines.push(`    quantiles: [${d.quantiles.join(', ')}],`);
    lines.push('  },');
  }
  lines.push('};', '');
  return lines.join('\n');
}

const isMain = process.argv[1]?.endsWith('calibrate.ts') || process.argv[1]?.endsWith('calibrate.js');

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const weeks = Number(flag('--weeks') ?? 26);
  const out = resolve(flag('--out') ?? 'src/analysis/calibration-table.ts');
  const store = args.includes('--store');
  const startedAt = new Date().toISOString();
  const status = (patch: Partial<CalibrationStatus>) => (store
    ? writeAppState(STATUS_KEY, JSON.stringify({ state: 'running', startedAt, finishedAt: null, error: null, ...patch }))
    : Promise.resolve());

  (async () => {
    getConfig();
    await waitForDatabase();
    await status({});
    // The adjustments are measured with none in force, then held for the
    // collection, whose DCF probabilities depend on them.
    usePremiumAdjustment(0);
    const premium = await impliedPremiumAdjustment();
    usePremiumAdjustment(premium?.adjustments ?? 0);
    for (const [key, g] of Object.entries(premium?.groups ?? {})) {
      logger.info(`Premium adjustment ${key}: ${(premium!.adjustments[key] * 100).toFixed(2)} points from ${g.stocks} stocks`);
    }
    const result = await calibrate(weeks);
    const source = render(result, weeks, premium);
    if (store) {
      const proposal: CalibrationProposal = {
        generatedAt: new Date().toISOString(), weeks,
        symbols: result.symbols, observations: result.observations, criteria: Object.keys(result.table).length,
        premiumAdjustments: premium?.adjustments ?? {},
        current: {
          generatedAt: CALIBRATION_META.generatedAt, symbols: CALIBRATION_META.symbols,
          observations: CALIBRATION_META.observations, premiumAdjustments: CALIBRATION_META.premiumAdjustments,
          criteria: Object.keys(CALIBRATION).length,
        },
        ...compareTables(CALIBRATION, result.table),
        source,
      };
      await writeAppState(PROPOSAL_KEY, JSON.stringify(proposal));
      await status({ state: 'done', finishedAt: new Date().toISOString() });
    } else {
      writeFileSync(out, source);
    }
    logger.success(
      `Calibrated ${Object.keys(result.table).length} criteria from ${result.symbols} symbols `
      + `(${result.observations} observations) → ${store ? 'app_state' : out}`,
    );
    await closePool();
  })().catch(async (e) => {
    logger.error(`Calibration failed: ${(e as Error).message}`);
    await status({ state: 'failed', finishedAt: new Date().toISOString(), error: (e as Error).message }).catch(() => {});
    await closePool();
    process.exit(1);
  });
}
