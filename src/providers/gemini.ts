import { GoogleGenerativeAI } from '@google/generative-ai';
import { LLMAnalysis, SearchResult } from '../types.js';
import { LLMProvider, SYSTEM_PROMPT, buildFullPrompt, parseJsonFromResponse } from './base.js';
import { logger } from '../utils/logger.js';

const DEFAULT_MODEL = 'gemini-1.5-pro';

export class GeminiProvider extends LLMProvider {
  readonly name = 'gemini';
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, modelId = DEFAULT_MODEL) {
    super();
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = modelId;
  }

  supportsNativeSearch(): boolean { return false; }

  async analyze(prompt: string, searchResults?: SearchResult[]): Promise<LLMAnalysis> {
    logger.step('Calling Gemini for analysis...');

    // Gemini has no separate system role — prepend to user message
    const fullPrompt = SYSTEM_PROMPT + '\nRespond ONLY with valid JSON, no markdown.\n\n'
      + buildFullPrompt(prompt, searchResults);

    const model = this.genAI.getGenerativeModel({ model: this.model });
    const result = await model.generateContent(fullPrompt);
    const text = result.response.text();

    logger.debug('Gemini raw response:', text.substring(0, 200));
    return parseJsonFromResponse(text);
  }
}
