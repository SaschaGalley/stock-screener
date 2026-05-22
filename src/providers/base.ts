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

  /**
   * Queries the provider issued during native web search (Claude
   * `web_search_20250305`, OpenAI `web_search_preview`). Read AFTER `analyze()`
   * completes. Default: empty array (provider didn't use native search). Stored
   * by the caller into the analysis cache for debug/inspection in the UI.
   */
  protected _nativeSearchQueries: string[] = [];
  getNativeSearchQueries(): string[] { return [...this._nativeSearchQueries]; }
}

export function parseJsonFromResponse(text: string): LLMAnalysis {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
  const raw = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;

  // Coerce a Bull/Bear case to a string array. Tolerates legacy string output
  // by splitting on bullet markers or sentence boundaries.
  function toBullets(v: unknown): string[] {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') {
      const lines = v.split(/\n[•\-*]\s|^\s*[•\-*]\s/m).map((s) => s.trim()).filter((s) => s.length > 5);
      return lines.length >= 2 ? lines : [v.trim()];
    }
    return ['Not provided'];
  }

  try {
    const parsed = JSON.parse(raw.trim()) as Partial<LLMAnalysis> & Record<string, unknown>;
    return {
      bullCase:          toBullets(parsed.bullCase),
      bearCase:          toBullets(parsed.bearCase),
      keyRisks:          Array.isArray(parsed.keyRisks) ? parsed.keyRisks : ['Not provided'],
      thesis:            (parsed.thesis as string)            ?? 'Not provided',
      score:             typeof parsed.score === 'number' ? Math.min(10, Math.max(0, parsed.score)) : 5,
      recommendation:    (parsed.recommendation as LLMAnalysis['recommendation']) ?? 'HOLD',
      fairValueEstimate: (parsed.fairValueEstimate as string) ?? 'Not provided',
    };
  } catch {
    return {
      bullCase:          [text.substring(0, 300)],
      bearCase:          ['Could not parse structured response.'],
      keyRisks:          ['Unable to parse LLM response'],
      thesis:            'Parse error — check verbose output.',
      score:             5,
      recommendation:    'HOLD',
      fairValueEstimate: 'N/A',
    };
  }
}
