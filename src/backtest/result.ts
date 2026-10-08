/**
 * What a backtest found, as stored for the page — every run in
 * `backtest_runs`, the newest the one shown — and how the run in progress is
 * getting on (`app_state`, `backtest.status`).
 *
 * Apart from the runner so that the server can read a result without loading
 * the SEC and Yahoo clients that produce one.
 */

import { readAppState, writeAppState } from '../db/admin.js';
import { query, queryOne } from '../db/client.js';
import type { BucketReturn, Evaluation } from '../analysis/evaluate.js';
import type { WeightValidation } from './weights.js';
import type { TopDecileStudy } from './top-decile.js';
import type { Fidelity } from './fidelity.js';
import type { FairValueStudy } from './fair-value.js';
import type { TimingStudy } from './timing.js';
import type { PortfolioStudy } from './portfolio.js';
import type { SetupStudy } from './setups.js';

export const RESULT_KEY = 'backtest.result';

export interface BacktestResult {
  generatedAt: string;
  from:        string;
  to:          string;
  /** Month-ends scored. */
  months:      number;
  /** Companies scored at least once. */
  companies:   number;
  /** "S&P 1500" or "S&P 500"; absent in results from before there was a choice (the 500). */
  universe?:   string;
  /**
   * The signals within each index of the composite — large, mid and small
   * caps — so a factor that works only further down is not averaged away.
   * Empty for a run on the 500 alone, absent in older results.
   */
  segments?:   { key: string; label: string; companies: number; ics: Evaluation['ics']; labels: Evaluation['labels']; bands?: Bands }[];
  /** The score's tenths, its verdicts and its steps, each against the month's average stock; absent in older results. */
  bands?:      Bands;
  /** The score assembled again under other rules from the same rows (`variants.ts`); absent in older results. */
  variants?:   VariantResult[];
  /** What the top tenth is made of, and which of it falls back (`top-decile.ts`); absent in older results. */
  topDecile?:  TopDecileStudy;
  /** The composite fair value put to the test (`fair-value.ts`), with the studies; absent in older results. */
  fairValue?:  FairValueStudy;
  /**
   * Whether it pays to wait for the chart, within each verdict (`timing.ts`).
   * Run every time — it is cheap — so not carried from an earlier run; absent
   * in older results.
   */
  timing?:     TimingStudy;
  /** Top-N portfolios by a signal against the index funds, after costs (`portfolio.ts`); every run, absent in older results. */
  portfolios?: PortfolioStudy;
  /** Trade setups against a random entry with the same stop and target (`setups.ts`); every run, absent in older results. */
  setups?:     SetupStudy;
  /**
   * When the studies above were computed, where that was an earlier run than
   * this one: they are run with `--studies` only, and carried to the page
   * from the newest run that has them.
   */
  studiesAt?:  string;
  /**
   * The newest live scores beside the backtest's of the same sessions: whether
   * the numbers above measure the score the app shows (`fidelity.ts`). Absent
   * in older results and in a run with no live scores to compare.
   */
  fidelity?:   Fidelity;
  /** Median premium adjustment over the months, and its range: the operating firms', measured on their DCFs. */
  premium:     { median: number; min: number; max: number };
  /**
   * The lenders' own, measured on their excess return model, over the months
   * with enough lenders to have one (`premiumTable`). Absent in older results.
   */
  lenderPremium?: { median: number; min: number; max: number; months: number };
  evaluation:  Evaluation;
  /**
   * Each candidate over one month in the first half of the months and in the
   * second, split as the weight check splits them (`WEIGHT_SPLIT`): a signal
   * must hold in both. Absent in older results.
   */
  candidateHalves?: CandidateHalves[];
  /**
   * The factor score's IC by calendar year, at one month, and the share of the
   * year's company-months with a rebuilt consensus target (absent in results
   * from before it was rebuilt, null in a run without it).
   */
  byYear:      { year: number; months: number; ic: number | null; neutralIc: number | null; analysts?: number | null }[];
  /** Companies that left the S&P 1500 since the start, and how many of them could be rebuilt; absent without. */
  departed?:   { departed: number; noFiler: number; noProfile: number; included: number };
  /** The weights fitted to it, and how the fit did on the months it had not seen. */
  fit:         WeightValidation;
  caveats:     string[];
}

export interface CandidateHalves {
  key:    string;
  /** The first half, then the second. */
  halves: { months: number; ic: number | null; tStat: number | null; neutralIc: number | null; neutralTStat: number | null }[];
}

/** The score cut up, each part against the average stock of the same months (`bucketReturns`). */
export interface Bands {
  /** By rank within the month, D1 the lowest tenth. */
  deciles:    BucketReturn[];
  /** The same for the score before the confidence shrink and the conviction stretch. */
  rawDeciles: BucketReturn[];
  /** By published factor verdict. */
  verdicts:   BucketReturn[];
  /** By whole points of the score: <3, 3–4 … 7–8, ≥8. */
  steps:      BucketReturn[];
}

export interface VariantResult {
  key:      string;
  label:    string;
  /** Share of the conviction stretch applied. */
  stretch:  number;
  /** The score (`score`) at every horizon, pooled and within the sector. */
  ics:      Evaluation['ics'];
  /** The same within each index. */
  segments: { key: string; ics: Evaluation['ics'] }[];
  deciles:  BucketReturn[];
  verdicts: BucketReturn[];
  /** The verdicts in 2013–2019 and in 2020–2026; absent in older results. */
  halves?:  BucketReturn[][];
  steps:    BucketReturn[];
  /** Share of all company-months each verdict held. */
  verdictShare: Record<string, number>;
}

export const BACKTEST_CAVEATS = [
  'Der Analystenkonsens ist aus Yahoos Rating-Historie rekonstruiert: je Haus das neueste Kursziel und Rating der zwölf Monate davor, '
    + 'ab drei Häusern. Vor 2020 ist die Historie dünner (Spalte „Konsens“ je Jahr). Schätzungen, Revisionen und Überraschungen gibt es '
    + 'rückwirkend nicht: Von „Erwartungen“ zählt nur die Rating-Veränderung, der DCF startet mit dem Wachstum der letzten zwölf Monate.',
  'Nur heutige Indexmitglieder, jedes ab seinem Aufnahmetag — wer den Index verlassen hat, fehlt (Survivorship). Für S&P 400 und 600 '
    + 'stammen die Aufnahmetage aus Wikipedias Wechseltabellen; wer dort nicht steht, zählt ab deren Beginn (S&P 600: Dezember 2019).',
  'Peer-Gruppen sind die GICS-Sub-Industries der Indexmitglieder, nicht die Finnhub-Gruppen.',
  'Kalibrierung und Prämienkorrektur werden je Monat nur aus dem Querschnitt dieses Monats bestimmt.',
];

/** Replaces the first caveat in a run made without the rebuilt consensus (`--no-analysts`). */
export const NO_ANALYSTS_CAVEAT =
  'Ohne Analystendaten gerechnet: Konsens und Erwartungen fehlen, der DCF startet mit dem Wachstum der letzten zwölf Monate.';

/** Replaces the survivorship caveat when the companies that left are in, as far as they could be found. */
export function departedCaveat(d: { departed: number; included: number }): string {
  return `Heutige Indexmitglieder ab ihrem Aufnahmetag, dazu ${d.included} der ${d.departed} Firmen, die den S&P 1500 seit 2013 `
    + 'verlassen haben, bis zu ihrem Austritt — die, die noch handeln und unter ihrem Ticker bei der SEC melden. Übernommene und insolvente '
    + 'Firmen fehlen weiter (Survivorship). Für S&P 400 und 600 stammen die Aufnahmetage aus Wikipedias Wechseltabellen; wer dort nicht '
    + 'steht, zählt ab deren Beginn (S&P 600: Dezember 2019).';
}

export type BacktestTrigger = 'cron' | 'manual' | 'cli';

/** Keep a finished run. */
export async function saveBacktestRun(r: BacktestResult, trigger: BacktestTrigger): Promise<void> {
  await query(
    `INSERT INTO backtest_runs (generated_at, trigger, universe, months, companies, result)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [r.generatedAt, trigger, r.universe ?? 'S&P 500', r.months, r.companies, JSON.stringify(r)],
  );
}

/** The newest stored result, or null before the first run. */
export async function storedBacktest(): Promise<BacktestResult | null> {
  try {
    const row = await queryOne<{ result: BacktestResult }>('SELECT result FROM backtest_runs ORDER BY generated_at DESC LIMIT 1');
    if (row) {
      if (row.result.variants || row.result.topDecile) return row.result;
      // The monthly run leaves the studies out; the newest that has them still answers their questions.
      const studies = await queryOne<{
        variants: BacktestResult['variants'] | null; top: TopDecileStudy | null; fair: FairValueStudy | null; at: Date;
      }>(
        `SELECT result -> 'variants' AS variants, result -> 'topDecile' AS top, result -> 'fairValue' AS fair, generated_at AS at
           FROM backtest_runs WHERE result ? 'variants' ORDER BY generated_at DESC LIMIT 1`,
      );
      return studies
        ? {
          ...row.result, variants: studies.variants ?? undefined, topDecile: studies.top ?? undefined,
          fairValue: studies.fair ?? undefined, studiesAt: studies.at.toISOString(),
        }
        : row.result;
    }
    // A database from before the runs were kept.
    const raw = await readAppState(RESULT_KEY);
    return raw ? JSON.parse(raw) as BacktestResult : null;
  } catch {
    return null;
  }
}

/**
 * What each factor verdict did in the newest backtest — the stocks it was
 * given to, against the average stock of the same month, one to twelve months
 * on — and how closely that backtest follows the app's score. Small enough to
 * ask for on every stock page; the whole result is not.
 */
export interface VerdictEvidence {
  generatedAt: string;
  universe:    string;
  from:        string;
  to:          string;
  verdicts:    BucketReturn[];
  /** The live comparison's rank correlation and verdict agreement, where the run made one. */
  fidelity:    { rho: number | null; same: number } | null;
  /** What the headline fair value's gap did, from the newest run that tested it (`fair-value.ts`); null before one did. */
  fair:        FairEvidence | null;
  /**
   * The timing study, with each reading's IC over the whole cross-section; null
   * for a run from before it (`timing.ts`).
   */
  timing:      (TimingStudy & { ics: { key: string; horizon: number; meanIc: number | null; tStat: number | null }[] }) | null;
  /** The setups against a random entry; null for a run from before them (`setups.ts`). */
  setups:      SetupStudy | null;
}

export interface FairEvidence {
  generatedAt: string;
  /** Rank IC of the gap ln(fair / price), one to twelve months on. */
  ics:         { horizon: number; ic: number | null; t: number | null }[];
  /** The share of the gap closed against the average stock. */
  closed:      { horizon: number; slope: number | null; t: number | null }[];
  /** What each place of the price in the primary range earned. */
  positions:   BucketReturn[];
}

export async function verdictEvidence(): Promise<VerdictEvidence | null> {
  const row = await queryOne<{
    generated_at: Date; universe: string | null; from: string; to: string;
    verdicts: BucketReturn[] | null; rho: number | null; same: number | null;
    timing: TimingStudy | null; setups: SetupStudy | null; timing_ics: { key: string; horizon: number; meanIc: number | null; tStat: number | null }[] | null;
  }>(
    `SELECT generated_at, universe, result ->> 'from' AS "from", result ->> 'to' AS "to",
            result -> 'bands' -> 'verdicts' AS verdicts,
            result -> 'timing' AS timing,
            result -> 'setups' AS setups,
            (SELECT jsonb_agg(jsonb_build_object('key', x -> 'key', 'horizon', x -> 'horizon', 'meanIc', x -> 'meanIc', 'tStat', x -> 'tStat'))
               FROM jsonb_array_elements(result -> 'evaluation' -> 'ics') x
              WHERE x ->> 'key' LIKE 'candidate.timing.%') AS timing_ics,
            (SELECT (x ->> 'rho')::float FROM jsonb_array_elements(result -> 'fidelity' -> 'scores') x
              WHERE x ->> 'key' = 'score') AS rho,
            (result -> 'fidelity' -> 'verdicts' ->> 'same')::float AS same
       FROM backtest_runs WHERE result -> 'bands' ? 'verdicts'
      ORDER BY generated_at DESC LIMIT 1`,
  );
  if (!row?.verdicts) return null;
  const fv = await queryOne<{ generated_at: Date; fair: FairValueStudy }>(
    `SELECT generated_at, result -> 'fairValue' AS fair FROM backtest_runs
      WHERE result ? 'fairValue' ORDER BY generated_at DESC LIMIT 1`,
  );
  return {
    generatedAt: row.generated_at.toISOString(), universe: row.universe ?? 'S&P 500', from: row.from, to: row.to,
    verdicts: row.verdicts,
    fidelity: row.same !== null ? { rho: row.rho, same: row.same } : null,
    fair: fv ? {
      generatedAt: fv.generated_at.toISOString(),
      ics: fv.fair.ics.filter((r) => r.key === 'fair.primary').map((r) => ({ horizon: r.horizon, ic: r.meanIc, t: r.tStat })),
      closed: fv.fair.convergence.filter((r) => r.lens === 'fair.primary').map((r) => ({ horizon: r.horizon, slope: r.slope, t: r.t })),
      positions: fv.fair.positions,
    } : null,
    timing: row.timing
      ? { ...row.timing, ics: (row.timing_ics ?? []).map((x) => ({ ...x, key: x.key.replace(/^candidate\./, '') })) }
      : null,
    setups: row.setups ?? null,
  };
}

/** One earlier run, as a line in the list of runs. */
export interface BacktestRunSummary {
  id:          number;
  generatedAt: string;
  trigger:     string;
  universe:    string | null;
  months:      number | null;
  companies:   number | null;
  /** The factor score at one month: IC, its t, and within the sector. */
  ic:          number | null;
  tStat:       number | null;
  neutralIc:   number | null;
  /** Whether the weight fit held up on the half it had not seen. */
  held:        boolean | null;
}

export async function backtestHistory(limit = 24): Promise<BacktestRunSummary[]> {
  const res = await query<{
    id: string; generated_at: Date; trigger: string; universe: string | null; months: number | null; companies: number | null;
    ic: number | null; t: number | null; neutral: number | null; held: boolean | null;
  }>(
    `SELECT id, generated_at, trigger, universe, months, companies,
            (ic ->> 'meanIc')::float8 AS ic, (ic ->> 'tStat')::float8 AS t, (ic ->> 'neutralIc')::float8 AS neutral,
            (result -> 'fit' ->> 'held')::boolean AS held
       FROM backtest_runs
       LEFT JOIN LATERAL (
         SELECT x AS ic FROM jsonb_array_elements(result -> 'evaluation' -> 'ics') x
          WHERE x ->> 'key' = 'score.factor.score' AND (x ->> 'horizon')::int = 1
          LIMIT 1
       ) h ON true
      ORDER BY generated_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    id: Number(r.id), generatedAt: r.generated_at.toISOString(), trigger: r.trigger, universe: r.universe,
    months: r.months, companies: r.companies, ic: r.ic, tStat: r.t, neutralIc: r.neutral, held: r.held,
  }));
}

// ── The run in progress ──────────────────────────────────────────────────────

export const STATUS_KEY = 'backtest.status';

export interface BacktestStatus {
  state:      'running' | 'done' | 'failed' | 'interrupted';
  trigger:    BacktestTrigger;
  startedAt:  string;
  /** Last written: the run writes at every step, so an old one with `running` is a run that died. */
  updatedAt:  string;
  finishedAt: string | null;
  /** What it is doing: "SEC-Abschlüsse 500/1502", "Monatsende 2018-06". */
  phase:      string | null;
  error:      string | null;
  /** Peak memory of the run, in megabytes. */
  peakMb:     number | null;
}

export async function readBacktestStatus(): Promise<BacktestStatus | null> {
  try {
    const raw = await readAppState(STATUS_KEY);
    return raw ? JSON.parse(raw) as BacktestStatus : null;
  } catch {
    return null;
  }
}

export async function writeBacktestStatus(s: BacktestStatus): Promise<void> {
  await writeAppState(STATUS_KEY, JSON.stringify(s));
}

