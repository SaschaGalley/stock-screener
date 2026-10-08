/**
 * Runtime configuration edited from the web UI's administration page.
 *
 * Distinct from `src/config.ts`, which reads process/env secrets at boot and
 * never changes while the server runs. This file holds the *operational*
 * settings a user turns knobs on: when the nightly pipeline runs, what each of
 * its steps does, and which symbols it covers.
 *
 * Stored as a single JSONB row in Postgres alongside the data it governs, so a
 * redeploy keeps both or loses both — never a schedule pointing at data that
 * isn't there.
 *
 * Every read repairs: unknown keys are dropped, invalid values fall back to the
 * default for that field only. A hand-edited row can degrade the setting it
 * broke, never the whole server.
 *
 * The zod work stays here and the raw row access lives in `db/admin.ts`; that
 * split is what keeps the database layer free of domain types.
 */

import { z } from 'zod';
import { logger } from './utils/logger.js';
import { readSettingsJson, writeSettingsJson } from './db/admin.js';
import { listSymbols } from './db/store.js';
import {
  DEFAULT_MODEL_ID, DEFAULT_PERPLEXITY_MODEL, DEFAULT_PIPELINE_MODEL_ID, DEFAULT_SUMMARY_MODEL_ID, PERPLEXITY_MODEL_IDS,
  PerplexityModelId, resolveModelId,
} from './models.js';
import { ADJUSTMENT_LIMIT, NARRATIVE_MAX_WEIGHT } from './analysis/score.js';

/** Cron field count we accept: standard 5-field (minute hour dom month dow). */
const CRON_RE = /^(\S+\s+){4}\S+$/;

export const AppConfigSchema = z.object({
  schedule: z.object({
    enabled:  z.boolean().default(true),
    /** 5-field cron. Default: every day at midnight. */
    cron:     z.string().regex(CRON_RE, 'expected a 5-field cron expression').default('0 0 * * *'),
    /** IANA zone the cron is interpreted in. */
    timezone: z.string().min(1).default('Europe/Berlin'),
  }).prefault({}),

  /**
   * The backtest, rerun on its own (`src/backtest-service.ts`). Monthly
   * rather than nightly: it scores month-ends, and a new one comes once a
   * month. The default is the 2nd at two in the afternoon, in the schedule's
   * zone — after the month-end close is in, and away from the night's refresh,
   * whose Yahoo, SEC and Finnhub budgets it would otherwise share.
   */
  backtest: z.object({
    enabled: z.boolean().default(true),
    cron:    z.string().regex(CRON_RE, 'expected a 5-field cron expression').default('0 14 2 * *'),
  }).prefault({}),

  steps: z.object({
    data: z.object({
      enabled: z.boolean().default(true),
    }).prefault({}),
    distill: z.object({
      enabled: z.boolean().default(true),
    }).prefault({}),
    analysis: z.object({
      enabled: z.boolean().default(true),
      /** Re-run only when the newest cached analysis is older than this. */
      maxAgeDays: z.number().int().min(1).max(365).default(5),
      /** Model id from the registry (or any provider-routable id). */
      model:   z.string().min(1).default(DEFAULT_PIPELINE_MODEL_ID),
      /** Search providers, same vocabulary as the CLI's `--search`. */
      search:  z.array(z.string()).default([]),
      pplx:    z.enum(PERPLEXITY_MODEL_IDS).nullable().default(null),
      /**
       * Escalate to web search for symbols with no sell-side coverage, even when
       * `search` is empty.
       *
       * Without this, a nightly run on the defaults gives an uncovered stock the
       * worst of both worlds: no analyst consensus *and* no external context, so
       * the verdict rests entirely on our own arithmetic. That is how a FACC
       * analysis came out as SELL on three-year-old numbers with nothing to
       * contradict them. Covered symbols are unaffected — they already have an
       * independent check and don't need the extra call.
       */
      searchWhenUncovered: z.boolean().default(true),
      /** Provider used by the escalation above. Ignored when it is disabled. */
      uncoveredSearchProvider: z.string().default('tavily'),
    }).prefault({}),
  }).prefault({}),

  /**
   * Perplexity research. Not under `steps`, because it governs every analysis
   * — a click in the web UI or a re-run as much as the nightly pass.
   */
  perplexity: z.object({
    /**
     * Serve the stored synthesis until it is this old. Each call is billed,
     * and at the former 12 hours nearly every analysis paid for a new one.
     * The refresh in Research & News is the way past it.
     */
    maxAgeDays: z.number().int().min(1).max(365).default(14),
    /**
     * How long a deep research report, bought by hand, keeps going into every
     * analysis beside the regular brief. Longer than the brief's window: it
     * costs ten times as much and is mostly about the business, not the week.
     */
    deepMaxAgeDays: z.number().int().min(1).max(365).default(60),
  }).prefault({}),

  /**
   * How the headline score is put together.
   *
   * Not under `steps`, for the same reason Perplexity is not: it governs every
   * analysis, whether it came from the nightly pass, a click in the web UI or
   * the CLI. The pillar weights themselves are deliberately *not* here — they
   * are the scoring model, and a model that can be retuned from a settings page
   * produces a history that cannot be compared with itself.
   */
  scoring: z.object({
    /** Cheap model for the two summariser stages. */
    summaryModel: z.string().min(1).default(DEFAULT_SUMMARY_MODEL_ID),
    /** Ceiling on the weight the prose-only score may carry in the blend. */
    narrativeMaxWeight: z.number().min(0).max(1).default(NARRATIVE_MAX_WEIGHT),
    /** How far the synthesis model may move the blended score, in points. */
    adjustmentLimit: z.number().min(0).max(3).default(ADJUSTMENT_LIMIT),
  }).prefault({}),

  /**
   * The reference universe (`src/universe.ts`): the S&P 1500, the EURO STOXX 50
   * and the DAX, refreshed on a rotation after the watchlist and scored on the
   * numbers alone, so that the calibration and the evaluation have a population
   * to read the score against.
   */
  universe: z.object({
    enabled:   z.boolean().default(true),
    /**
     * Reference symbols refreshed per night; the universe comes round every
     * size / batchSize nights. 250 brings some 1,600 members round in a week.
     */
    batchSize: z.number().int().min(0).max(600).default(250),
  }).prefault({}),

  /**
   * The depot check (`src/depot-check-service.ts`): which stocks off the depot
   * it analyses, below what score a held one is weighed for reducing, and
   * which Perplexity model writes the market brief.
   */
  depotCheck: z.object({
    /** Score a stock outside the depot needs to be analysed as a candidate. */
    minScore:      z.number().min(0).max(10).default(8),
    /** At most this many, the best first: each costs an analysis and a chart reading. */
    maxCandidates: z.number().int().min(1).max(50).default(25),
    /** A held stock scored below this is weighed for reducing. */
    reduceBelow:   z.number().min(0).max(10).default(5),
    /** The market brief's model; null asks for none. Reused for twelve hours. */
    marketModel:   z.enum(PERPLEXITY_MODEL_IDS).nullable().default(DEFAULT_PERPLEXITY_MODEL),
  }).prefault({}),

  /**
   * Where a verdict change on the watchlist is announced once it has held
   * (`src/alerts.ts`). `json` suits any endpoint that takes a JSON POST —
   * Slack reads `text`, Discord `content`; `ntfy` posts to an ntfy topic URL
   * as ntfy reads it. Empty is off; every change is still listed on the
   * overview.
   */
  alerts: z.object({
    webhookUrl: z.union([z.string().url(), z.literal('')]).default(''),
    format:     z.enum(['json', 'ntfy']).default('json'),
    /**
     * After the night's watchlist pass, one message with what happened since
     * the last — rating changes, insider trades, the quarter's numbers, price
     * jumps (`src/digest.ts`). Off, only the verdict changes are sent.
     */
    digest:     z.boolean().default(true),
    /**
     * After the same pass, the depot's night watch (`src/depot-watch-service.ts`):
     * a stock held whose close fell under its trailing stop or the last
     * depot check's stop, or whose score fell under the reduce bar while its
     * chart turned down — each announced once, the night it appears.
     */
    depotWatch: z.boolean().default(true),
  }).prefault({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/** Parsing `{}` yields every default, so the defaults live in one place only. */
export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});

/**
 * Read the stored config, falling back to defaults per field.
 *
 * Repair rather than reject: a value that fails validation (a mistyped cron, a
 * removed model) is replaced by its default and logged, so the scheduler keeps
 * running on a sane config instead of the server refusing to start.
 */
export async function readAppConfig(): Promise<AppConfig> {
  const raw = await readSettingsJson();
  if (raw === null) return DEFAULT_APP_CONFIG;

  const parsed = AppConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  logger.warn(`Stored settings have invalid fields — repairing: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return repair(raw);
}

/**
 * Field-wise fallback for a config that failed whole-object validation. Each
 * top-level section is parsed on its own, so one bad cron string can't reset
 * the alerts.
 */
function repair(raw: unknown): AppConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const section = <K extends keyof AppConfig>(key: K): AppConfig[K] => {
    const shape = AppConfigSchema.shape[key];
    const result = shape.safeParse(obj[key]);
    return (result.success ? result.data : DEFAULT_APP_CONFIG[key]) as AppConfig[K];
  };
  // Every section of the schema, so a new one is repaired without being listed here.
  const keys = Object.keys(AppConfigSchema.shape) as (keyof AppConfig)[];
  return Object.fromEntries(keys.map((k) => [k, section(k)])) as AppConfig;
}

/** Persist a full config. Returns what was actually written. */
export async function writeAppConfig(next: AppConfig): Promise<AppConfig> {
  const validated = AppConfigSchema.parse(next);
  await writeSettingsJson(validated);
  logger.info(`Settings updated (schedule ${validated.schedule.enabled ? validated.schedule.cron : 'disabled'})`);
  return validated;
}

/** The analysis step's flags, normalised the way the cache key expects them. */
export function analysisFlagsFor(config: AppConfig): {
  model: string;
  search: string;
  pplx: PerplexityModelId | null;
} {
  const { model, search, pplx } = config.steps.analysis;
  return {
    model:  resolveModelId(model || DEFAULT_MODEL_ID),
    search: search.length === 0 ? 'none' : [...search].sort().join(','),
    pplx,
  };
}

/**
 * The watchlist: symbols the nightly run covers, in the order it walks them —
 * every stock on the list. There was a per-stock opt-out in the administration;
 * nobody used it, and a stock left unticked there was a stock the list showed
 * with a verdict that silently stopped moving.
 *
 * Lives here rather than in `pipeline/steps.ts` because it is the *definition*
 * of the watchlist, and more than the pipeline needs it — the Distill dossier
 * sync mirrors exactly this set. Keeping it in the pipeline module made that
 * sync import the pipeline, which imported it back.
 */
export async function scheduledSymbols(): Promise<string[]> {
  return (await listSymbols()).sort();
}
