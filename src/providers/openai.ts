import OpenAI from 'openai';
import { LLMAnalysis, SearchResult } from '../types.js';
import { LLMProvider, SYSTEM_PROMPT, buildFullPrompt, parseJsonFromResponse } from './base.js';
import { logger } from '../utils/logger.js';
import { defaultModelFor } from '../models.js';

const DEFAULT_MODEL = defaultModelFor('openai');
const SEARCH_MODEL  = 'gpt-4o-mini'; // Responses API web_search_preview

export class OpenAIProvider extends LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private model: string;
  private useNativeSearch: boolean;

  constructor(apiKey: string, modelId = DEFAULT_MODEL, useNativeSearch = false) {
    super();
    this.client = new OpenAI({ apiKey });
    this.model = modelId;
    this.useNativeSearch = useNativeSearch;
  }

  supportsNativeSearch(): boolean { return true; }

  async analyze(prompt: string, searchResults?: SearchResult[]): Promise<LLMAnalysis> {
    logger.step('Calling OpenAI for analysis...');

    if (this.useNativeSearch) {
      return this.analyzeWithNativeSearch(prompt);
    }

    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: 2048,
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

    // Reset per-call so a reused provider doesn't accumulate across runs.
    this._nativeSearchQueries = [];

    const response = await this.client.responses.create({
      model: SEARCH_MODEL,
      tools: [{ type: 'web_search_preview' }],
      instructions: SYSTEM_PROMPT,
      input: prompt,
    });

    // Capture the queries OpenAI issued. The Responses API surfaces each
    // web_search call as an output item of type 'web_search_call'. Its action
    // is a union — only the 'search' variant carries a query; 'open_page' and
    // 'find' are follow-up steps on a page it already opened.
    const output = Array.isArray(response.output) ? response.output : [];
    for (const item of output) {
      if (item.type === 'web_search_call' && item.action.type === 'search') {
        const q = item.action.query;
        if (typeof q === 'string' && q.length > 0) this._nativeSearchQueries.push(q);
      }
    }

    const text: string = response.output_text ?? '';
    logger.debug('OpenAI native search response:', text.substring(0, 200));
    return parseJsonFromResponse(text);
  }
}
