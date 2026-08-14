/**
 * Single source of truth for every selectable model.
 *
 * Consumed by the CLI (shortcut → provider + model ID), the server
 * (`GET /api/models`) and the web UI (picker labels + cache-key resolution).
 * Adding, retiring or renaming a model means editing `MODELS` below and
 * nothing else — help text, error messages, the picker and the provider
 * defaults are all derived from it.
 *
 * Kept dependency-free on purpose: the web app imports this file directly
 * (through Vite, `moduleResolution: bundler`), so it must not pull in any
 * NodeNext-style `./x.js` relative import or Node built-in.
 */

export const PROVIDERS = ['claude', 'openai'] as const;
export type ModelProvider = (typeof PROVIDERS)[number];

export interface ModelDef {
  /** Shortcut typed after `--model`, and the value stored in web settings. */
  id: string;
  /** Model ID actually sent to the API. Also the analysis cache key. */
  resolved: string;
  /** Human label for the web UI picker. */
  label: string;
  provider: ModelProvider;
  /** Additional accepted shortcuts, not shown in the picker. */
  aliases?: string[];
}

/**
 * Order matters: the picker renders in this order, and the first entry of a
 * provider is that provider's fallback model (see `defaultModelFor`).
 */
export const MODELS: ModelDef[] = [
  { id: 'claude', resolved: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'claude', aliases: ['sonnet'] },
  { id: 'opus',   resolved: 'claude-opus-5',   label: 'Claude Opus 5',   provider: 'claude' },
  { id: 'terra',  resolved: 'gpt-5.6-terra',   label: 'GPT-5.6 Terra',   provider: 'openai' },
  { id: 'luna',   resolved: 'gpt-5.6-luna',    label: 'GPT-5.6 Luna',    provider: 'openai' },
  { id: 'mini',   resolved: 'gpt-5.4-mini',    label: 'GPT-5.4 Mini',    provider: 'openai' },
];

/** Used when neither `--model` nor a stored web setting says otherwise. */
export const DEFAULT_MODEL_ID = 'claude';

/**
 * Full model IDs that aren't shortcuts still route to a provider by prefix, so
 * a brand-new model can be used via `--model <id>` before it earns a shortcut.
 * `hint` is the human-readable form of `test`, used in help and error text.
 */
const ID_PATTERNS: { provider: ModelProvider; test: RegExp; hint: string }[] = [
  { provider: 'claude', test: /^claude-/,         hint: 'claude-*' },
  { provider: 'openai', test: /^(gpt|o1|o3|o4)/,  hint: 'gpt-* | o1-*' },
];

function findShortcut(input: string): ModelDef | undefined {
  const lc = input.toLowerCase();
  return MODELS.find((m) => m.id === lc || m.aliases?.includes(lc));
}

/**
 * Shortcut or full model ID → the exact ID sent to the API. Unrecognised input
 * passes through unchanged so custom IDs still reach the provider.
 */
export function resolveModelId(input: string): string {
  return findShortcut(input)?.resolved ?? input;
}

/** `null` when the input is neither a shortcut nor a recognised full model ID. */
export function providerFor(input: string): ModelProvider | null {
  const shortcut = findShortcut(input);
  if (shortcut) return shortcut.provider;
  const lc = input.toLowerCase();
  return ID_PATTERNS.find((p) => p.test.test(lc))?.provider ?? null;
}

/** Fallback model for a provider — the first one listed for it. */
export function defaultModelFor(provider: ModelProvider): string {
  const model = MODELS.find((m) => m.provider === provider);
  if (!model) throw new Error(`No model configured for provider "${provider}"`);
  return model.resolved;
}

/** e.g. `claude | sonnet | opus | terra | luna | mini` — for help and errors. */
export function shortcutList(provider?: ModelProvider): string {
  return MODELS
    .filter((m) => provider === undefined || m.provider === provider)
    .flatMap((m) => [m.id, ...(m.aliases ?? [])])
    .join(' | ');
}

/** e.g. `claude-* | gpt-* | o1-*` — the full-ID escape hatch, for help text. */
export function fullIdList(provider?: ModelProvider): string {
  return ID_PATTERNS
    .filter((p) => provider === undefined || p.provider === provider)
    .map((p) => p.hint)
    .join(' | ');
}

/** Everything `--model` accepts, for one-line help and error messages. */
export function acceptedModels(provider?: ModelProvider): string {
  return `${shortcutList(provider)} | ${fullIdList(provider)}`;
}
