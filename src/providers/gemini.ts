import { GoogleGenerativeAI } from '@google/generative-ai';
import { LLMAnalysis, SearchResult, StockFinancials } from '../types.js';
import { LLMProvider, parseJsonFromResponse } from './base.js';
import { logger } from '../utils/logger.js';

const MODEL = 'gemini-1.5-pro';

export class GeminiProvider extends LLMProvider {
  readonly name = 'gemini';
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    super();
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  supportsNativeSearch(): boolean {
    return false;
  }

  async analyze(
    prompt: string,
    _financials: StockFinancials,
    searchResults?: SearchResult[],
  ): Promise<LLMAnalysis> {
    logger.step('Calling Gemini for analysis...');

    let fullPrompt = `You are an expert financial analyst. Analyze stocks with rigorous fundamental analysis.
Respond ONLY with valid JSON matching this exact structure (no markdown, no explanation):
{
  "bullCase": "string",
  "bearCase": "string",
  "keyRisks": ["string", "string", "string"],
  "thesis": "string (1-2 sentences)",
  "score": number (0-10),
  "recommendation": "STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL",
  "fairValueEstimate": "string (e.g. '$120 - $145')"
}

${prompt}`;

    if (searchResults && searchResults.length > 0) {
      fullPrompt += '\n\n## Recent Web Search Results\n';
      searchResults.slice(0, 5).forEach((r, i) => {
        fullPrompt += `\n### [${i + 1}] ${r.title}\n${r.content.substring(0, 500)}\n`;
      });
    }

    const model = this.genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(fullPrompt);
    const text = result.response.text();

    logger.debug('Gemini raw response:', text.substring(0, 200));
    return parseJsonFromResponse(text);
  }
}
