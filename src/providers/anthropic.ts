import Anthropic from '@anthropic-ai/sdk';
import { LLMAnalysis, SearchResult } from '../types.js';
import { LLMProvider, SYSTEM_PROMPT, buildFullPrompt, parseJsonFromResponse } from './base.js';
import { logger } from '../utils/logger.js';

const MODEL = 'claude-sonnet-4-6';

export class AnthropicProvider extends LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private useNativeSearch: boolean;

  constructor(apiKey: string, useNativeSearch = false) {
    super();
    this.client = new Anthropic({ apiKey });
    this.useNativeSearch = useNativeSearch;
  }

  supportsNativeSearch(): boolean { return true; }

  async analyze(prompt: string, searchResults?: SearchResult[]): Promise<LLMAnalysis> {
    logger.step('Calling Claude for analysis...');

    if (this.useNativeSearch) {
      return this.analyzeWithNativeSearch(prompt);
    }

    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildFullPrompt(prompt, searchResults) }],
    });

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n');

    logger.debug('Claude raw response:', text.substring(0, 200));
    return parseJsonFromResponse(text);
  }

  private async analyzeWithNativeSearch(prompt: string): Promise<LLMAnalysis> {
    logger.step('Claude native web search enabled...');

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
    let text = '';

    // Agentic loop — Claude may call web_search multiple times
    for (let round = 0; round < 5; round++) {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        // web_search_20250305 is a built-in tool not yet reflected in SDK v0.28 types
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: [{ type: 'web_search_20250305', name: 'web_search' }] as any,
        messages,
      });

      if (response.stop_reason === 'end_turn') {
        text = response.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('\n');
        break;
      }

      if (response.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = response.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: (b as { type: 'tool_use'; id: string }).id,
          content: 'Search completed.',
        }));

      messages.push({ role: 'user', content: toolResults });
    }

    return parseJsonFromResponse(text);
  }
}
