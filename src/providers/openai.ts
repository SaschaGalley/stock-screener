import OpenAI from 'openai';
import { CompletionRequest, LLMProvider, LLMTruncatedError, parseStructured } from './base.js';
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

  async complete<T>(req: CompletionRequest<T>): Promise<T> {
    logger.step(`Calling ${this.model} (${req.label})...`);

    if (this.useNativeSearch) return this.completeWithNativeSearch(req);

    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: req.maxTokens ?? 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: req.system },
        { role: 'user',   content: req.user },
      ],
    });

    const choice = completion.choices[0];
    const text = choice?.message?.content ?? '';
    if (choice?.finish_reason === 'length') {
      throw new LLMTruncatedError(req.label, req.maxTokens, text);
    }
    logger.debug(`OpenAI raw response (${req.label}):`, text.substring(0, 200));
    return parseStructured(text, req.schema, req.label);
  }

  private async completeWithNativeSearch<T>(req: CompletionRequest<T>): Promise<T> {
    logger.step('OpenAI native web search enabled...');

    // Reset per-call so a reused provider doesn't accumulate across runs.
    this._nativeSearchQueries = [];

    const response = await this.client.responses.create({
      model: SEARCH_MODEL,
      tools: [{ type: 'web_search_preview' }],
      instructions: req.system,
      input: req.user,
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
    logger.debug(`OpenAI native search response (${req.label}):`, text.substring(0, 200));
    return parseStructured(text, req.schema, req.label);
  }
}
