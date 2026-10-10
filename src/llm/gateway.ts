/**
 * The model gateway: the owner's self-hosted LiteLLM proxy. With
 * `LITELLM_BASE_URL` and `LITELLM_API_KEY` set, every model call goes through
 * it under its task's name (`stock-cli/analysis`, `stock-cli/depot-manager` …,
 * `MODEL_TASKS`), and which model does a task is decided there, in one place;
 * the proxy also counts what each task costs. Without them the providers are
 * called directly with the models the administration names.
 *
 * What a task's model is, the proxy says before a call (`/v1/model/info`) and
 * after it (a response header): the first goes into what is stored with an
 * answer — an analysis's flags, a chart reading, a depot check — so that the
 * record says which model wrote it even after the proxy is switched to another.
 *
 * Deep research stays off the proxy: it has to stream, and a streamed answer
 * through the proxy arrives without Perplexity's sources (tested 10.10.2026).
 */

import { getConfig, requireApiKey } from '../config.js';
import { isPerplexityModel, MODEL_TASKS, type ModelTask, type PerplexityModelId } from '../models.js';
import { logger } from '../utils/logger.js';

export const taskAlias = (task: ModelTask): string => `stock-cli/${task}`;

/** The proxy's address and key, or null when calls go to the providers directly. */
export function gateway(): { baseUrl: string; apiKey: string } | null {
  const { litellmBaseUrl, litellmApiKey } = getConfig();
  return litellmBaseUrl && litellmApiKey ? { baseUrl: litellmBaseUrl.replace(/\/+$/, ''), apiKey: litellmApiKey } : null;
}

/**
 * A model as the proxy names it, as this app does: without the provider's
 * prefix — `perplexity/sonar-pro` is `sonar-pro`, `anthropic/claude-opus-5-5`
 * is `claude-opus-5-5`.
 */
export function plainModel(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

const TASK_KEYS = new Set<string>(MODEL_TASKS.map((t) => t.key));

/**
 * The tasks' models from the proxy's `/v1/model/info`, by task; tasks the
 * proxy does not know are left out, and so are names under `stock-cli/` that
 * are not one of the app's tasks.
 */
export function tasksFromModelInfo(info: unknown): Partial<Record<ModelTask, string>> {
  const rows = (info as { data?: unknown })?.data;
  const out: Partial<Record<ModelTask, string>> = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows as { model_name?: unknown; litellm_params?: { model?: unknown } }[]) {
    const name = typeof r?.model_name === 'string' ? r.model_name : '';
    const task = name.startsWith('stock-cli/') ? name.slice(10) : '';
    const model = r?.litellm_params?.model;
    // The first deployment of a task names it; more behind one name are the proxy's load balancing.
    if (TASK_KEYS.has(task) && typeof model === 'string' && !(task in out)) {
      out[task as ModelTask] = plainModel(model);
    }
  }
  return out;
}

/** Asked at most this often: a switch in the proxy shows within minutes. */
const INFO_TTL_MS = 5 * 60_000;
let info: { at: number; tasks: Promise<Partial<Record<ModelTask, string>>> } | null = null;

/** Each task's model as the proxy has it now; empty without a proxy or when it cannot be asked. */
export function taskModels(): Promise<Partial<Record<ModelTask, string>>> {
  const g = gateway();
  if (!g) return Promise.resolve({});
  if (info && Date.now() - info.at < INFO_TTL_MS) return info.tasks;
  const tasks = fetch(`${g.baseUrl}/v1/model/info`, {
    headers: { Authorization: `Bearer ${g.apiKey}` }, signal: AbortSignal.timeout(10_000),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return tasksFromModelInfo(await r.json());
    })
    .catch((e: Error) => {
      logger.warn(`LiteLLM model info: ${e.message}`);
      info = null;
      return {};
    });
  info = { at: Date.now(), tasks };
  return tasks;
}

/**
 * The model that does `task`: the proxy's, where it has one for it, else
 * `fallback` — the administration's, which is also what a call falls back to
 * when the proxy cannot be reached.
 */
export async function modelForTask(task: ModelTask, fallback: string): Promise<string> {
  return (await taskModels())[task] ?? fallback;
}

/**
 * `task` where the proxy has it set up, else `fallback`: a task added to the
 * app before its name is created in the proxy runs on another's model there,
 * rather than failing on a name the proxy does not know.
 */
export async function taskOrFallback(task: ModelTask, fallback: ModelTask): Promise<ModelTask> {
  if (!gateway()) return task;
  return (await taskModels())[task] ? task : fallback;
}

/** A Perplexity task's model; the proxy's only where it is one of Perplexity's, whose settings the app knows. */
export async function perplexityModelForTask(task: ModelTask, fallback: PerplexityModelId): Promise<PerplexityModelId> {
  const m = await modelForTask(task, fallback);
  return isPerplexityModel(m) ? m : fallback;
}

/** Perplexity's own key: needed only without the proxy, and for deep research, which never goes through it. */
export function perplexityKey(): string {
  return gateway() ? getConfig().pplxApiKey ?? '' : requireApiKey('perplexity');
}
