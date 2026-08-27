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
import { DEFAULT_MODEL_ID, DEFAULT_PIPELINE_MODEL_ID, resolveModelId } from './models.js';

/** Cron field count we accept: standard 5-field (minute hour dom month dow). */
const CRON_RE = /^(\S+\s+){4}\S+$/;

/**
 * What the Distill step does per symbol.
 *  - `refresh` → POST /briefings/refresh: drains pending insights upstream and
 *    generates a briefing when there is substance. Costs LLM budget on the
 *    Distill instance, and is the only mode that produces *new* briefings.
 *  - `fetch`   → GET /briefings: pulls whatever is currently published. Free.
 */
export const DISTILL_MODES = ['refresh', 'fetch'] as const;
export type DistillMode = (typeof DISTILL_MODES)[number];

export const AppConfigSchema = z.object({
  schedule: z.object({
    enabled:  z.boolean().default(true),
    /** 5-field cron. Default: every day at midnight. */
    cron:     z.string().regex(CRON_RE, 'expected a 5-field cron expression').default('0 0 * * *'),
    /** IANA zone the cron is interpreted in. */
    timezone: z.string().min(1).default('Europe/Berlin'),
  }).prefault({}),

  steps: z.object({
    data: z.object({
      enabled: z.boolean().default(true),
    }).prefault({}),
    distill: z.object({
      enabled: z.boolean().default(true),
      mode:    z.enum(DISTILL_MODES).default('refresh'),
    }).prefault({}),
    analysis: z.object({
      enabled: z.boolean().default(true),
      /** Re-run only when the newest cached analysis is older than this. */
      maxAgeDays: z.number().int().min(1).max(365).default(5),
      /** Model id from the registry (or any provider-routable id). */
      model:   z.string().min(1).default(DEFAULT_PIPELINE_MODEL_ID),
      /** Search providers, same vocabulary as the CLI's `--search`. */
      search:  z.array(z.string()).default([]),
      pplx:    z.enum(['sonar', 'sonar-pro']).nullable().default(null),
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
   * Per-symbol opt-out. Absent means "included" — a newly analysed stock joins
   * the nightly run without anyone having to remember to enable it.
   */
  watchlist: z.record(z.string(), z.boolean()).default({}),
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
 * the watchlist.
 */
function repair(raw: unknown): AppConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const section = <K extends keyof AppConfig>(key: K): AppConfig[K] => {
    const shape = AppConfigSchema.shape[key];
    const result = shape.safeParse(obj[key]);
    return (result.success ? result.data : DEFAULT_APP_CONFIG[key]) as AppConfig[K];
  };
  return {
    schedule:  section('schedule'),
    steps:     section('steps'),
    watchlist: section('watchlist'),
  };
}

/** Persist a full config. Returns what was actually written. */
export async function writeAppConfig(next: AppConfig): Promise<AppConfig> {
  const validated = AppConfigSchema.parse(next);
  await writeSettingsJson(validated);
  logger.info(`Settings updated (schedule ${validated.schedule.enabled ? validated.schedule.cron : 'disabled'})`);
  return validated;
}

/** Is this symbol covered by the nightly run? Unknown symbols default to yes. */
export function isWatched(config: AppConfig, symbol: string): boolean {
  return config.watchlist[symbol.toUpperCase()] !== false;
}

/** The analysis step's flags, normalised the way the cache key expects them. */
export function analysisFlagsFor(config: AppConfig): {
  model: string;
  search: string;
  pplx: 'sonar' | 'sonar-pro' | null;
} {
  const { model, search, pplx } = config.steps.analysis;
  return {
    model:  resolveModelId(model || DEFAULT_MODEL_ID),
    search: search.length === 0 ? 'none' : [...search].sort().join(','),
    pplx,
  };
}

/**
 * The watchlist: symbols the nightly run covers, in the order it walks them.
 *
 * Lives beside `isWatched` rather than in `pipeline/steps.ts` because it is the
 * *definition* of the watchlist, and more than the pipeline needs it — the
 * Distill dossier sync mirrors exactly this set. Keeping it in the pipeline
 * module made that sync import the pipeline, which imported it back.
 */
export async function scheduledSymbols(config: AppConfig): Promise<string[]> {
  return (await listSymbols()).filter((s) => isWatched(config, s)).sort();
}
