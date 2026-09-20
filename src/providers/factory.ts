import { LLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { requireApiKey } from '../config.js';
import { AnalysisOptions } from '../types.js';
import { ModelProvider, providerFor } from '../models.js';

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
