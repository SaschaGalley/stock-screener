import { LLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { requireApiKey } from '../config.js';
import { AnalysisOptions } from '../types.js';

export function createProvider(options: AnalysisOptions): LLMProvider {
  const useNativeSearch = options.search === 'claude-native';

  switch (options.model) {
    case 'anthropic': {
      const key = requireApiKey('anthropic');
      return new AnthropicProvider(key, useNativeSearch);
    }
    case 'openai': {
      const key = requireApiKey('openai');
      return new OpenAIProvider(key);
    }
    case 'gemini': {
      const key = requireApiKey('gemini');
      return new GeminiProvider(key);
    }
    default:
      throw new Error(`Unknown provider: ${options.model}`);
  }
}
