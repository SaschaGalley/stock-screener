import OpenAI from 'openai';
import { LLMAnalysis, SearchResult } from '../types.js';
import { LLMProvider, SYSTEM_PROMPT, buildFullPrompt, parseJsonFromResponse } from './base.js';
import { logger } from '../utils/logger.js';

const MODEL = 'gpt-5.4-mini';
const SEARCH_MODEL = 'gpt-4o-mini';

export class OpenAIProvider extends LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private useNativeSearch: boolean;

  constructor(apiKey: string, useNativeSearch = false) {
    super();
    this.client = new OpenAI({ apiKey });
    this.useNativeSearch = useNativeSearch;
  }

  supportsNativeSearch(): boolean { return true; }

  async analyze(prompt: string, searchResults?: SearchResult[]): Promise<LLMAnalysis> {
    logger.step('Calling OpenAI for analysis...');

    if (this.useNativeSearch) {
      return this.analyzeWithNativeSearch(prompt);
    }

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

  private async analyzeWithNativeSearch(prompt: string): Promise<LLMAnalysis> {
    logger.step('OpenAI native web search enabled...');

    // Responses API with web_search_preview tool
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (this.client as any).responses.create({
      model: SEARCH_MODEL,
      tools: [{ type: 'web_search_preview' }],
      instructions: SYSTEM_PROMPT,
      input: prompt,
    });

    const text: string = response.output_text ?? '';
    logger.debug('OpenAI native search response:', text.substring(0, 200));
    return parseJsonFromResponse(text);
  }
}
