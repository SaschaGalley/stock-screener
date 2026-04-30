import { LLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { requireApiKey } from '../config.js';
import { AnalysisOptions } from '../types.js';

export function createProvider(options: AnalysisOptions): LLMProvider {
  switch (options.model) {
    case 'anthropic': {
      const key = requireApiKey('anthropic');
      return new AnthropicProvider(key, options.search === 'claude-native');
    }
    case 'openai': {
      const key = requireApiKey('openai');
      return new OpenAIProvider(key, options.search === 'openai-native');
    }
    case 'gemini': {
      const key = requireApiKey('gemini');
      return new GeminiProvider(key);
    }
    default:
      throw new Error(`Unknown provider: ${options.model}`);
  }
}
