import { LLMAnalysis, SearchResult, StockFinancials } from '../types.js';

export abstract class LLMProvider {
  abstract readonly name: string;
  abstract supportsNativeSearch(): boolean;

  abstract analyze(
    prompt: string,
    financials: StockFinancials,
    searchResults?: SearchResult[],
  ): Promise<LLMAnalysis>;
}

export function parseJsonFromResponse(text: string): LLMAnalysis {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
  const raw = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;

  try {
    const parsed = JSON.parse(raw.trim()) as Partial<LLMAnalysis>;
    return {
      bullCase: parsed.bullCase ?? 'Not provided',
      bearCase: parsed.bearCase ?? 'Not provided',
      keyRisks: Array.isArray(parsed.keyRisks) ? parsed.keyRisks : ['Not provided'],
      thesis: parsed.thesis ?? 'Not provided',
      score: typeof parsed.score === 'number' ? Math.min(10, Math.max(0, parsed.score)) : 5,
      recommendation: parsed.recommendation ?? 'HOLD',
      fairValueEstimate: parsed.fairValueEstimate ?? 'Not provided',
    };
  } catch {
    return {
      bullCase: text.substring(0, 500),
      bearCase: 'Could not parse structured response.',
      keyRisks: ['Unable to parse LLM response'],
      thesis: 'Parse error — check verbose output.',
      score: 5,
      recommendation: 'HOLD',
      fairValueEstimate: 'N/A',
    };
  }
}
