import { config } from 'dotenv';
import { z } from 'zod';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env') });

const ConfigSchema = z.object({
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  googleGeminiApiKey: z.string().optional(),
  finnhubApiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  braveApiKey: z.string().optional(),
  fredApiKey: z.string().optional(),
  cacheDir: z.string().default('~/.investment-cli-cache'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;

  const raw = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    googleGeminiApiKey: process.env.GOOGLE_GEMINI_API_KEY,
    finnhubApiKey: process.env.FINNHUB_API_KEY,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    braveApiKey: process.env.BRAVE_API_KEY,
    fredApiKey: process.env.FRED_API_KEY,
    cacheDir: process.env.CACHE_DIR,
    logLevel: process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined,
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Configuration error: ${result.error.message}`);
  }

  _config = result.data;
  return _config;
}

export function requireApiKey(provider: 'anthropic' | 'openai' | 'gemini' | 'finnhub' | 'tavily' | 'brave'): string {
  const cfg = getConfig();
  const keyMap: Record<string, string | undefined> = {
    anthropic: cfg.anthropicApiKey,
    openai: cfg.openaiApiKey,
    gemini: cfg.googleGeminiApiKey,
    finnhub: cfg.finnhubApiKey,
    tavily: cfg.tavilyApiKey,
    brave: cfg.braveApiKey,
  };

  const envMap: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GOOGLE_GEMINI_API_KEY',
    finnhub: 'FINNHUB_API_KEY',
    tavily: 'TAVILY_API_KEY',
    brave: 'BRAVE_API_KEY',
  };

  const key = keyMap[provider];
  if (!key) {
    throw new Error(`Missing API key for ${provider}. Set ${envMap[provider]} in your .env file.`);
  }
  return key;
}
