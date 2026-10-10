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
  /**
   * Whether Anthropic may re-run a declined request on another model inside
   * the same call (`fallbacks: "default"`). Only the models whose safety
   * classifiers can decline accept the parameter; for the others it is a 400.
   */
  refusalFallback?: boolean;
}

/**
 * Order matters: the picker renders in this order, and the first entry of a
 * provider is that provider's fallback model (see `defaultModelFor`).
 */
export const MODELS: ModelDef[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'claude', aliases: ['claude', 'sonnet'], refusalFallback: true },
  { id: 'claude-opus-5-5',   label: 'Claude Opus 5.5',   provider: 'claude', aliases: ['opus'],             refusalFallback: true },
  { id: 'claude-fable-5-1',  label: 'Claude Fable 5.1',  provider: 'claude', aliases: ['fable'],            refusalFallback: true },
  { id: 'gpt-6.1-sol',       label: 'GPT-6.1 Sol',       provider: 'openai', aliases: ['sol'] },
  { id: 'gpt-6-astra',       label: 'GPT-6 Astra',       provider: 'openai', aliases: ['astra'] },
  { id: 'gpt-6-luna',        label: 'GPT-6 Luna',        provider: 'openai', aliases: ['luna'] },
  { id: 'gpt-5.4-mini',      label: 'GPT-5.4 Mini',      provider: 'openai', aliases: ['mini'] },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'claude', aliases: ['haiku'] },
];

/**
 * The jobs a model does in this app. With the LiteLLM proxy configured
 * (`src/llm/gateway.ts`) each is called by its own name there —
 * `stock-cli/analysis` and so on — and the proxy decides which model does it;
 * without, the administration's settings name the model. `perplexity` marks
 * the jobs that need Perplexity's searching models and their sources.
 */
export const MODEL_TASKS = [
  { key: 'analysis',       label: 'Analyse',           perplexity: false, hint: 'Jede Aktienanalyse, nachts und per Klick, samt der Synthese, die den Score setzt.' },
  { key: 'summary',        label: 'Zusammenfassungen', perplexity: false, hint: 'Die zwei Stufen vor der Synthese, die Berichte und Recherche verdichten: ein günstiges Modell reicht.' },
  { key: 'chart-read',     label: 'Chartlesung',       perplexity: false, hint: 'Im Depot-Check und im Chart-Tab einer Aktie.' },
  { key: 'depot-manager',  label: 'Depotmanager',      perplexity: false, hint: 'Ein Aufruf je Depot-Check, der das ganze Depot abwägt: der Platz für das stärkste Modell.' },
  { key: 'market-brief',   label: 'Marktlage',         perplexity: true,  hint: 'Für den Depot-Check: Lage, Rotation, Sektoren, Termine. Zwölf Stunden wiederverwendet.' },
  { key: 'stock-research', label: 'Recherche je Aktie', perplexity: true, hint: 'Was die Kennzahlen nicht zeigen, für jede Analyse; 14 Tage wiederverwendet.' },
  { key: 'deep-research',  label: 'Deep Research',     perplexity: true,  hint: 'Per Knopf in der Recherche einer Aktie; läuft immer direkt bei Perplexity, weil der Proxy beim Streamen die Quellen verliert.' },
] as const;
export type ModelTask = (typeof MODEL_TASKS)[number]['key'];

/** Used when neither `--model` nor a stored web setting says otherwise. */
export const DEFAULT_MODEL_ID = 'claude-sonnet-5-5';

/**
 * Default for the scheduled pipeline, which re-analyses the whole watchlist and
 * therefore favours throughput over the interactive default. Lives here rather
 * than as a string literal in app-config.ts so retiring a model is still a
 * one-file edit — the point of this registry.
 */
export const DEFAULT_PIPELINE_MODEL_ID = 'gpt-6.1-sol';

/**
 * Default for the two summariser stages of the verdict pipeline.
 *
 * Those calls do not judge anything — one renders an already-computed score card
 * as prose, the other reads dossiers and reports what they say. Both are
 * comprehension tasks, which is what the cheap tier is good at, and running them
 * on the synthesis model would triple the cost of a nightly pass for no gain in
 * the one number anybody looks at.
 */
export const DEFAULT_SUMMARY_MODEL_ID = 'gpt-5.4-mini';

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

// ── Perplexity ───────────────────────────────────────────────────────────────

/**
 * The Perplexity models a research brief can be bought from — the one list the
 * CLI, the server, the settings and both pickers derive from.
 *
 * `costUsd` is what one brief cost on the comparison run of 3 October 2026
 * (ServiceNow and Fresenius Medical Care, the API's own cost figures). It is
 * shown beside the choice, not used to bill. Sonar was not part of that run;
 * its figure is the price list applied to the same answer length. Deep
 * research varies the most: it decides itself how many searches to run.
 */
export const PERPLEXITY_MODELS = [
  {
    id: 'sonar', label: 'Sonar', costUsd: 0.02,
    note: 'günstig, flacher, stuft Firmenquellen oft als unabhängig ein',
  },
  {
    id: 'sonar-pro', label: 'Sonar Pro', costUsd: 0.10,
    note: 'unter einer Minute, solide Breite',
  },
  {
    id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro', costUsd: 0.10,
    note: 'rund drei Minuten, findet andere Dinge als Pro',
  },
  {
    id: 'sonar-deep-research', label: 'Sonar Deep Research', costUsd: 0.80,
    note: 'vier bis fünf Minuten, 50+ Suchen — am gründlichsten',
  },
] as const satisfies readonly { id: string; label: string; costUsd: number; note: string }[];

export type PerplexityModelId = (typeof PERPLEXITY_MODELS)[number]['id'];
export const PERPLEXITY_MODEL_IDS = PERPLEXITY_MODELS.map((m) => m.id) as [PerplexityModelId, ...PerplexityModelId[]];

/**
 * The model that is bought by hand and kept beside the regular brief rather
 * than in its place — see `readDeepResearch` in `db/store.ts`.
 */
export const DEEP_RESEARCH_MODEL: PerplexityModelId = 'sonar-deep-research';

/** Used when Perplexity is asked for without a model. */
export const DEFAULT_PERPLEXITY_MODEL: PerplexityModelId = 'sonar-pro';

/**
 * Where a deep research report can come from besides the API: the research
 * mode of a chat app on a subscription, run with the copied brief and pasted
 * back in by hand. Stored in the deep research slot all the same — the first
 * is the default.
 */
export const MANUAL_RESEARCH_TOOLS = ['Perplexity', 'ChatGPT', 'Claude', 'Gemini'] as const;
export type ManualResearchTool = (typeof MANUAL_RESEARCH_TOOLS)[number];
export const isManualResearchTool = (v: unknown): v is ManualResearchTool =>
  typeof v === 'string' && (MANUAL_RESEARCH_TOOLS as readonly string[]).includes(v);

export function isPerplexityModel(v: unknown): v is PerplexityModelId {
  return typeof v === 'string' && (PERPLEXITY_MODEL_IDS as string[]).includes(v);
}

/** `Sonar Pro (~0,10 $)` — the picker label, with what a call costs. */
export function perplexityLabel(id: PerplexityModelId): string {
  const m = PERPLEXITY_MODELS.find((x) => x.id === id)!;
  return `${m.label} (~${m.costUsd.toFixed(2).replace('.', ',')} $)`;
}
