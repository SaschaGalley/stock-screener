import { GoogleGenerativeAI } from '@google/generative-ai';
import { LLMAnalysis, SearchResult } from '../types.js';
import { LLMProvider, SYSTEM_PROMPT, buildFullPrompt, parseJsonFromResponse } from './base.js';
import { logger } from '../utils/logger.js';

const MODEL = 'gemini-1.5-pro';

export class GeminiProvider extends LLMProvider {
  readonly name = 'gemini';
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    super();
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  supportsNativeSearch(): boolean { return false; }

  async analyze(prompt: string, searchResults?: SearchResult[]): Promise<LLMAnalysis> {
    logger.step('Calling Gemini for analysis...');

    // Gemini has no separate system role — prepend to user message
    const fullPrompt = SYSTEM_PROMPT + '\nRespond ONLY with valid JSON, no markdown.\n\n'
      + buildFullPrompt(prompt, searchResults);

    const model = this.genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(fullPrompt);
    const text = result.response.text();

    logger.debug('Gemini raw response:', text.substring(0, 200));
    return parseJsonFromResponse(text);
  }
}
