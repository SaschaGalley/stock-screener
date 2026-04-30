import { LLMAnalysis, SearchResult } from '../types.js';

export const SYSTEM_PROMPT = `You are an expert financial analyst. Analyze stocks with rigorous fundamental analysis.
Always respond with valid JSON matching this exact structure:
{
  "bullCase": "string",
  "bearCase": "string",
  "keyRisks": ["string", "string", "string"],
  "thesis": "string (1-2 sentences)",
  "score": number (0-10),
  "recommendation": "STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL",
  "fairValueEstimate": "string (e.g. '$120 - $145')"
}`;

export function buildFullPrompt(prompt: string, searchResults?: SearchResult[]): string {
  if (!searchResults || searchResults.length === 0) return prompt;
  let full = prompt + '\n\n## Recent Web Search Results\n';
  searchResults.slice(0, 5).forEach((r, i) => {
    full += `\n### [${i + 1}] ${r.title}\n${r.content.substring(0, 500)}\n`;
  });
  return full;
}

export abstract class LLMProvider {
  abstract readonly name: string;
  abstract supportsNativeSearch(): boolean;
  abstract analyze(prompt: string, searchResults?: SearchResult[]): Promise<LLMAnalysis>;
}

export function parseJsonFromResponse(text: string): LLMAnalysis {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
  const raw = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;

  try {
    const parsed = JSON.parse(raw.trim()) as Partial<LLMAnalysis>;
    return {
      bullCase:          parsed.bullCase          ?? 'Not provided',
      bearCase:          parsed.bearCase          ?? 'Not provided',
      keyRisks:          Array.isArray(parsed.keyRisks) ? parsed.keyRisks : ['Not provided'],
      thesis:            parsed.thesis            ?? 'Not provided',
      score:             typeof parsed.score === 'number' ? Math.min(10, Math.max(0, parsed.score)) : 5,
      recommendation:    parsed.recommendation    ?? 'HOLD',
      fairValueEstimate: parsed.fairValueEstimate ?? 'Not provided',
    };
  } catch {
    return {
      bullCase:          text.substring(0, 500),
      bearCase:          'Could not parse structured response.',
      keyRisks:          ['Unable to parse LLM response'],
      thesis:            'Parse error — check verbose output.',
      score:             5,
      recommendation:    'HOLD',
      fairValueEstimate: 'N/A',
    };
  }
}
