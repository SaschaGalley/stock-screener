import Anthropic from '@anthropic-ai/sdk';
import { CompletionRequest, LLMProvider, parseStructured } from './base.js';
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

  async complete<T>(req: CompletionRequest<T>): Promise<T> {
    logger.step(`Calling ${this.model} (${req.label})...`);

    if (this.useNativeSearch) return this.completeWithNativeSearch(req);

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 2048,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    });

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    logger.debug(`Claude raw response (${req.label}):`, text.substring(0, 200));
    return parseStructured(text, req.schema, req.label);
  }

  private async completeWithNativeSearch<T>(req: CompletionRequest<T>): Promise<T> {
    logger.step('Claude native web search enabled...');

    // Reset per-call so a reused provider doesn't accumulate across runs.
    this._nativeSearchQueries = [];

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.user }];
    let text = '';

    // web_search is a *server* tool: Anthropic runs the fetch itself and feeds
    // the results back into the same turn, so there is never a tool_result for
    // us to return. The one reason to loop is `pause_turn` — Anthropic ends the
    // turn early on a long search run and expects it handed straight back.
    for (let round = 0; round < 5; round++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
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

    return parseStructured(text, req.schema, req.label);
  }
}
