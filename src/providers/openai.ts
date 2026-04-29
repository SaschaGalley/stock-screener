import OpenAI from 'openai';
import { LLMAnalysis, SearchResult, StockFinancials } from '../types.js';
import { LLMProvider, parseJsonFromResponse } from './base.js';
import { logger } from '../utils/logger.js';

const MODEL = 'gpt-4-turbo';

export class OpenAIProvider extends LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    super();
    this.client = new OpenAI({ apiKey });
  }

  supportsNativeSearch(): boolean {
    return false;
  }

  async analyze(
    prompt: string,
    _financials: StockFinancials,
    searchResults?: SearchResult[],
  ): Promise<LLMAnalysis> {
    logger.step('Calling OpenAI for analysis...');

    let fullPrompt = prompt;
    if (searchResults && searchResults.length > 0) {
      fullPrompt += '\n\n## Recent Web Search Results\n';
      searchResults.slice(0, 5).forEach((r, i) => {
        fullPrompt += `\n### [${i + 1}] ${r.title}\n${r.content.substring(0, 500)}\n`;
      });
    }

    const completion = await this.client.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are an expert financial analyst. Analyze stocks with rigorous fundamental analysis.
Always respond with valid JSON matching this exact structure:
{
  "bullCase": "string",
  "bearCase": "string",
  "keyRisks": ["string", "string", "string"],
  "thesis": "string (1-2 sentences)",
  "score": number (0-10),
  "recommendation": "STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL",
  "fairValueEstimate": "string (e.g. '$120 - $145')"
}`,
        },
        { role: 'user', content: fullPrompt },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? '';
    logger.debug('OpenAI raw response:', text.substring(0, 200));
    return parseJsonFromResponse(text);
  }
}
