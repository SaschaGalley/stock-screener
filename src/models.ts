/**
 * Single source of truth for every selectable model.
 *
 * Consumed by the CLI (`--model`), the server (`GET /api/models`), the provider
 * defaults and the web UI picker. Adding, retiring or renaming a model means
 * editing `MODELS` below and nothing else — help text, error messages, defaults
 * and the picker are all derived from it.
 *
 * Kept dependency-free on purpose: the web app imports this file directly
 * (through Vite, `moduleResolution: bundler`), so it must not pull in any
 * NodeNext-style `./x.js` relative import or Node built-in.
 */

export const PROVIDERS = ['claude', 'openai'] as const;
export type ModelProvider = (typeof PROVIDERS)[number];

export interface ModelDef {
  /**
   * The model ID sent to the API — the single identity of a model. Also what
   * gets stored in web settings and used as the analysis cache key, so that a
   * cached entry and a picker selection compare as-is with no translation step.
   */
  id: string;
  /** Human label for the web UI picker. */
  label: string;
  provider: ModelProvider;
  /** Short `--model` aliases. Convenience for typing only — never stored. */
  aliases?: string[];
}

/**
 * Order matters: the picker renders in this order, and the first entry of a
 * provider is that provider's fallback model (see `defaultModelFor`).
 */
export const MODELS: ModelDef[] = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'claude', aliases: ['claude', 'sonnet'] },
  { id: 'claude-opus-5',   label: 'Claude Opus 5',   provider: 'claude', aliases: ['opus'] },
  { id: 'gpt-5.6-terra',   label: 'GPT-5.6 Terra',   provider: 'openai', aliases: ['terra'] },
  { id: 'gpt-5.6-luna',    label: 'GPT-5.6 Luna',    provider: 'openai', aliases: ['luna'] },
  { id: 'gpt-5.4-mini',    label: 'GPT-5.4 Mini',    provider: 'openai', aliases: ['mini'] },
];

/** Used when neither `--model` nor a stored web setting says otherwise. */
export const DEFAULT_MODEL_ID = 'claude-sonnet-5';

/**
 * Model IDs outside the registry still route to a provider by prefix, so a
 * brand-new model can be used via `--model <id>` before it earns an entry.
 * `hint` is the human-readable form of `test`, used in help and error text.
 */
const ID_PATTERNS: { provider: ModelProvider; test: RegExp; hint: string }[] = [
  { provider: 'claude', test: /^claude-/,         hint: 'claude-*' },
  { provider: 'openai', test: /^(gpt|o1|o3|o4)/,  hint: 'gpt-* | o1-*' },
];

/** Look up a registry entry by its ID or by one of its aliases. */
export function findModel(input: string): ModelDef | undefined {
  const lc = input.toLowerCase();
  return MODELS.find((m) => m.id.toLowerCase() === lc || m.aliases?.includes(lc));
}

/**
 * Alias or model ID → the exact ID sent to the API. Unrecognised input passes
 * through unchanged so custom IDs still reach the provider.
 */
export function resolveModelId(input: string): string {
  return findModel(input)?.id ?? input;
}

/** `null` when the input is neither a registry entry nor a recognised model ID. */
export function providerFor(input: string): ModelProvider | null {
  const model = findModel(input);
  if (model) return model.provider;
  const lc = input.toLowerCase();
  return ID_PATTERNS.find((p) => p.test.test(lc))?.provider ?? null;
}

/** Fallback model for a provider — the first one listed for it. */
export function defaultModelFor(provider: ModelProvider): string {
  const model = MODELS.find((m) => m.provider === provider);
  if (!model) throw new Error(`No model configured for provider "${provider}"`);
  return model.id;
}

/** e.g. `claude | sonnet | opus` — the typing shortcuts, for help and errors. */
export function aliasList(provider?: ModelProvider): string {
  return MODELS
    .filter((m) => provider === undefined || m.provider === provider)
    .flatMap((m) => m.aliases ?? [])
    .join(' | ');
}

/** e.g. `claude-* | gpt-* | o1-*` — the beyond-the-registry escape hatch. */
export function fullIdList(provider?: ModelProvider): string {
  return ID_PATTERNS
    .filter((p) => provider === undefined || p.provider === provider)
    .map((p) => p.hint)
    .join(' | ');
}

/** Everything `--model` accepts for a provider, for one-line error messages. */
export function acceptedModels(provider?: ModelProvider): string {
  return `${aliasList(provider)} | ${fullIdList(provider)}`;
}
