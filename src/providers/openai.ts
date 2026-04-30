import OpenAI from 'openai';
import { LLMAnalysis, SearchResult } from '../types.js';
import { LLMProvider, SYSTEM_PROMPT, buildFullPrompt, parseJsonFromResponse } from './base.js';
import { logger } from '../utils/logger.js';

const MODEL = 'gpt-5.4-mini';

export class OpenAIProvider extends LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    super();
    this.client = new OpenAI({ apiKey });
  }

  supportsNativeSearch(): boolean { return false; }

  async analyze(prompt: string, searchResults?: SearchResult[]): Promise<LLMAnalysis> {
    logger.step('Calling OpenAI for analysis...');

    const completion = await this.client.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildFullPrompt(prompt, searchResults) },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? '';
    logger.debug('OpenAI raw response:', text.substring(0, 200));
    return parseJsonFromResponse(text);
  }
}
