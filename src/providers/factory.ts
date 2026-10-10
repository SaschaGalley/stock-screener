import { LLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { LiteLLMProvider } from './litellm.js';
import { OpenAIProvider } from './openai.js';
import { requireApiKey } from '../config.js';
import { gateway } from '../llm/gateway.js';
import { AnalysisOptions } from '../types.js';
import { ModelProvider, ModelTask, providerFor } from '../models.js';

/**
 * The provider for one of the app's tasks: through the LiteLLM proxy under the
 * task's name where one is configured, else `model` directly. A native web
 * search is the providers' own tool and always goes to them directly; so does
 * the call when the proxy cannot be reached, with `model`.
 */
export function providerForTask(task: ModelTask, model: string, useNativeSearch = false): LLMProvider {
  const g = gateway();
  if (!g || useNativeSearch) return createProviderForModel(model, useNativeSearch);
  return new LiteLLMProvider(g.baseUrl, g.apiKey, task, () => {
    try { return createProviderForModel(model); } catch { return null; }
  });
}

/**
 * A provider for one model id, with no analysis options around it.
 *
 * The summariser stages pick their own (cheap) model, and routing it by prefix
 * is exactly what `providerFor` already does for `--model`. Native search is
 * off: a summariser works from the material it was handed, and a model that
 * goes looking for more would reintroduce the unaccountable input this whole
 * pipeline exists to remove.
 */
export function createProviderForModel(modelId: string, useNativeSearch = false): LLMProvider {
  const provider: ModelProvider | null = providerFor(modelId);
  if (provider === null) {
    throw new Error(`No provider routes model "${modelId}" — expected a claude-* or gpt-* id`);
  }
  return provider === 'claude'
    ? new AnthropicProvider(requireApiKey('claude'), modelId, useNativeSearch)
    : new OpenAIProvider(requireApiKey('openai'), modelId, useNativeSearch);
}

export function createProvider(options: AnalysisOptions): LLMProvider {
  switch (options.provider) {
    case 'claude': {
      const key = requireApiKey('claude');
      return new AnthropicProvider(key, options.modelId, options.search === 'claude');
    }
    case 'openai': {
      const key = requireApiKey('openai');
      return new OpenAIProvider(key, options.modelId, options.search === 'openai');
    }
    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}
