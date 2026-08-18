import Anthropic from '@anthropic-ai/sdk';
import { LLMAnalysis, SearchResult } from '../types.js';
import { LLMProvider, SYSTEM_PROMPT, buildFullPrompt, parseJsonFromResponse } from './base.js';
import { logger } from '../utils/logger.js';
import { defaultModelFor } from '../models.js';

const DEFAULT_MODEL = defaultModelFor('claude');

export class AnthropicProvider extends LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;
  private useNativeSearch: boolean;

  constructor(apiKey: string, modelId = DEFAULT_MODEL, useNativeSearch = false) {
    super();
    this.client = new Anthropic({ apiKey });
    this.model = modelId;
    this.useNativeSearch = useNativeSearch;
  }

  supportsNativeSearch(): boolean { return true; }

  async analyze(prompt: string, searchResults?: SearchResult[]): Promise<LLMAnalysis> {
    logger.step('Calling Claude for analysis...');

    if (this.useNativeSearch) {
      return this.analyzeWithNativeSearch(prompt);
    }

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildFullPrompt(prompt, searchResults) }],
    });

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    logger.debug('Claude raw response:', text.substring(0, 200));
    return parseJsonFromResponse(text);
  }

  private async analyzeWithNativeSearch(prompt: string): Promise<LLMAnalysis> {
    logger.step('Claude native web search enabled...');

    // Reset per-call so a reused provider doesn't accumulate across runs.
    this._nativeSearchQueries = [];

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
    let text = '';

    // web_search is a *server* tool: Anthropic runs the fetch itself and feeds
    // the results back into the same turn, so there is never a tool_result for
    // us to return. The one reason to loop is `pause_turn` — Anthropic ends the
    // turn early on a long search run and expects it handed straight back.
    for (let round = 0; round < 5; round++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      });

      // Capture the query Claude issued — the server tool's `input.query` is
      // the only visible breadcrumb, since the results never stream back to us.
      for (const b of response.content) {
        if (b.type === 'server_tool_use' && b.name === 'web_search') {
          const q = (b.input && typeof b.input === 'object' && 'query' in b.input)
            ? String((b.input as { query: unknown }).query)
            : null;
          if (q) this._nativeSearchQueries.push(q);
        }
      }

      // Accumulate: a paused turn splits the answer across rounds.
      text += response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      if (response.stop_reason !== 'pause_turn') break;

      messages.push({ role: 'assistant', content: response.content });
    }

    return parseJsonFromResponse(text);
  }
}
