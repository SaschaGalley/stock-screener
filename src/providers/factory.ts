import { LLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { requireApiKey } from '../config.js';
import { AnalysisOptions } from '../types.js';

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
    case 'gemini': {
      const key = requireApiKey('gemini');
      return new GeminiProvider(key, options.modelId);
    }
    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}
