import { config } from 'dotenv';
import { z } from 'zod';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env') });

const ConfigSchema = z.object({
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  finnhubApiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  braveApiKey: z.string().optional(),
  fredApiKey: z.string().optional(),
  pplxApiKey: z.string().optional(),
  distillApiKey: z.string().optional(),
  distillApiUrl: z.string().default('http://localhost:3000'),
  // A malformed briefing-type id should disable the feature, not crash the
  // process; a bad LOG_LEVEL should fall back to 'info'. `.catch()` degrades
  // gracefully instead of failing safeParse for the whole config.
  distillBriefingTypeId: z.string().uuid().optional().catch(undefined),
  /**
   * Postgres connection string. Required — the app has no second store to fall
   * back to. Absence is reported by `getPool()` with an actionable message
   * rather than failing config parsing at import time, so `--help` still works
   * without a database.
   */
  databaseUrl: z.string().optional(),
  /**
   * Where the two file-shaped things live (EDGAR filings, generated reports).
   * Named `dataDir` because it is no longer a cache: deleting it now loses
   * downloaded filings rather than a rebuildable copy.
   */
  dataDir: z.string().default('~/.investment-cli-data'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info').catch('info'),
  /**
   * Hatchet task-queue token. Only the token lives here, because the SDK reads
   * every `HATCHET_CLIENT_*` variable out of the environment itself — copying
   * host, namespace and TLS settings into this schema would be a second place
   * to keep them right. What the app needs to know is narrower: whether
   * Hatchet is configured at all, which the presence of a token answers.
   */
  hatchetToken: z.string().optional(),
});

/**
 * Environment-derived configuration: secrets and paths, read once at boot.
 * Named apart from `app-config.ts`'s `AppConfig` (the operational settings the
 * admin page edits) — two types called AppConfig in one codebase is an import
 * away from a confusing bug.
 */
export type EnvConfig = z.infer<typeof ConfigSchema>;

let _config: EnvConfig | null = null;

export function getConfig(): EnvConfig {
  if (_config) return _config;

  const raw = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    finnhubApiKey: process.env.FINNHUB_API_KEY,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    braveApiKey: process.env.BRAVE_API_KEY,
    fredApiKey: process.env.FRED_API_KEY,
    pplxApiKey: process.env.PPLX_API_KEY,
    distillApiKey: process.env.DISTILL_API_KEY,
    distillApiUrl: process.env.DISTILL_API_URL,
    distillBriefingTypeId: process.env.DISTILL_BRIEFING_TYPE_ID,
    databaseUrl: process.env.DATABASE_URL,
    // CACHE_DIR is still honoured so an existing deployment keeps finding its
    // downloaded filings after the rename.
    dataDir: process.env.DATA_DIR ?? process.env.CACHE_DIR,
    logLevel: process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined,
    hatchetToken: process.env.HATCHET_CLIENT_TOKEN,
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Configuration error: ${result.error.message}`);
  }

  _config = result.data;
  return _config;
}

export function requireApiKey(provider: 'claude' | 'anthropic' | 'openai' | 'finnhub' | 'tavily' | 'brave' | 'perplexity' | 'distill'): string {
  const cfg = getConfig();
  const keyMap: Record<string, string | undefined> = {
    claude:      cfg.anthropicApiKey, // alias
    anthropic:   cfg.anthropicApiKey,
    openai:      cfg.openaiApiKey,
    finnhub:     cfg.finnhubApiKey,
    tavily:      cfg.tavilyApiKey,
    brave:       cfg.braveApiKey,
    perplexity:  cfg.pplxApiKey,
    distill:     cfg.distillApiKey,
  };

  const envMap: Record<string, string> = {
    claude:      'ANTHROPIC_API_KEY',
    anthropic:   'ANTHROPIC_API_KEY',
    openai:      'OPENAI_API_KEY',
    finnhub:     'FINNHUB_API_KEY',
    tavily:      'TAVILY_API_KEY',
    brave:       'BRAVE_API_KEY',
    perplexity:  'PPLX_API_KEY',
    distill:     'DISTILL_API_KEY',
  };

  const key = keyMap[provider];
  if (!key) {
    throw new Error(`Missing API key for ${provider}. Set ${envMap[provider]} in your .env file.`);
  }
  return key;
}
