/**
 * Runtime configuration edited from the web UI's administration page.
 *
 * Distinct from `src/config.ts`, which reads process/env secrets at boot and
 * never changes while the server runs. This file holds the *operational*
 * settings a user turns knobs on: when the nightly pipeline runs, what each of
 * its steps does, and which symbols it covers.
 *
 * Stored as JSON next to the caches (`$CACHE_DIR/app-config.json`) rather than
 * in the repo: in a container it lives on the same persistent volume as the
 * data it governs, so a redeploy keeps both or loses both — never a schedule
 * pointing at a cache that isn't there.
 *
 * Every read repairs: unknown keys are dropped, invalid values fall back to the
 * default for that field only. A hand-edited file can degrade the setting it
 * broke, never the whole server.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { logger } from './utils/logger.js';
import { DEFAULT_MODEL_ID, resolveModelId } from './models.js';

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
  }).default({}),

  steps: z.object({
    data: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
    distill: z.object({
      enabled: z.boolean().default(true),
      mode:    z.enum(DISTILL_MODES).default('refresh'),
    }).default({}),
    analysis: z.object({
      enabled: z.boolean().default(true),
      /** Re-run only when the newest cached analysis is older than this. */
      maxAgeDays: z.number().int().min(1).max(365).default(5),
      /** Model id from the registry (or any provider-routable id). */
      model:   z.string().min(1).default('gpt-5.6-terra'),
      /** Search providers, same vocabulary as the CLI's `--search`. */
      search:  z.array(z.string()).default([]),
      pplx:    z.enum(['sonar', 'sonar-pro']).nullable().default(null),
    }).default({}),
  }).default({}),

  /**
   * Per-symbol opt-out. Absent means "included" — a newly analysed stock joins
   * the nightly run without anyone having to remember to enable it.
   */
  watchlist: z.record(z.string(), z.boolean()).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/** Parsing `{}` yields every default, so the defaults live in one place only. */
export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});

function resolveCacheRoot(rawDir: string): string {
  if (rawDir.startsWith('~')) return join(homedir(), rawDir.slice(1));
  if (isAbsolute(rawDir)) return rawDir;
  return resolve(process.cwd(), rawDir);
}

function configFile(cacheDir: string): string {
  return join(resolveCacheRoot(cacheDir), 'app-config.json');
}

/**
 * Read the stored config, falling back to defaults per field.
 *
 * Repair rather than reject: a value that fails validation (a mistyped cron, a
 * removed model) is replaced by its default and logged, so the scheduler keeps
 * running on a sane config instead of the server refusing to start.
 */
export function readAppConfig(cacheDir: string): AppConfig {
  const file = configFile(cacheDir);
  if (!existsSync(file)) return DEFAULT_APP_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    logger.warn(`app-config.json is unreadable (${(e as Error).message}) — using defaults.`);
    return DEFAULT_APP_CONFIG;
  }

  const parsed = AppConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  logger.warn(`app-config.json has invalid fields — repairing: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
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

/** Persist a full config atomically. Returns what was actually written. */
export function writeAppConfig(cacheDir: string, next: AppConfig): AppConfig {
  const validated = AppConfigSchema.parse(next);
  const root = resolveCacheRoot(cacheDir);
  mkdirSync(root, { recursive: true });

  const file = configFile(cacheDir);
  const tmp  = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf-8');
  renameSync(tmp, file);
  logger.info(`app-config.json updated (schedule ${validated.schedule.enabled ? validated.schedule.cron : 'disabled'})`);
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
