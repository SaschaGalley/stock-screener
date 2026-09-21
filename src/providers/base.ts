/**
 * One shape for every model call: a prompt in, a validated object out.
 *
 * The providers used to expose a single `analyze()` that knew what an
 * `LLMAnalysis` was, parsed one out of the response by hand, and quietly
 * substituted a HOLD at score 5 when parsing failed. That made a second kind of
 * call — a cheap model summarising something — impossible to add without
 * copying the whole method, and it made a malformed response indistinguishable
 * from a genuine neutral verdict.
 *
 * `complete()` takes the schema instead. The caller says what it wants back,
 * gets it validated, and gets an exception when the model did not deliver —
 * which the multi-stage pipeline can then degrade around deliberately (a failed
 * narrative summary is a missing half, not a neutral one).
 */

import { z } from 'zod';
import { SearchResult } from '../types.js';

export interface CompletionRequest<T> {
  /** Role and output contract. Must mention JSON — OpenAI's JSON mode requires it. */
  system:     string;
  user:       string;
  schema:     z.ZodType<T>;
  /** Short name for logs, e.g. `narrative` or `synthesis`. */
  label:      string;
  maxTokens?: number;
}

/** Search snippets appended as prose. Only the narrative stage passes these. */
export function appendSearchResults(prompt: string, searchResults?: SearchResult[]): string {
  if (!searchResults || searchResults.length === 0) return prompt;
  let full = `${prompt}\n\n### Rohe Web-Suchtreffer (unkuratiert — nur für Aktualität und Faktencheck)\n`;
  searchResults.slice(0, 5).forEach((r, i) => {
    full += `\n**[${i + 1}] ${r.title}**\n${r.content.substring(0, 500)}\n`;
  });
  return full;
}

/**
 * Thrown when the model ran out of budget before finishing its JSON.
 *
 * Distinct from a malformed response because the remedy is different and the
 * symptom is identical: a truncated object fails `JSON.parse` with "Unexpected
 * end of JSON input", which reads as the model misbehaving when it was simply
 * cut off. On the reasoning models the budget covers thinking as well as
 * output, so a long prompt can consume it before a single brace is emitted.
 */
export class LLMTruncatedError extends Error {
  constructor(label: string, limit: number | undefined, readonly raw: string) {
    super(`${label}: the model hit its token limit${limit ? ` (${limit})` : ''} before finishing its JSON`
      + ` — ${raw.length} characters came back. Raise maxTokens for this stage.`);
    this.name = 'LLMTruncatedError';
  }
}

export class LLMResponseError extends Error {
  constructor(label: string, detail: string, readonly raw: string) {
    super(`${label}: ${detail}`);
    this.name = 'LLMResponseError';
  }
}

/**
 * Pull the JSON object out of a response and validate it.
 *
 * Models fence their JSON, prefix it with a sentence, or both. The extraction
 * is deliberately forgiving and the validation deliberately is not: a response
 * that parses but does not match the schema is a failure the caller has to see.
 */
export function parseStructured<T>(text: string, schema: z.ZodType<T>, label: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const braced = text.match(/\{[\s\S]*\}/);
  const raw = (fenced?.[1] ?? braced?.[0] ?? text).trim();

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new LLMResponseError(label, `response was not JSON (${(e as Error).message})`, text);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .slice(0, 5)
      .join('; ');
    throw new LLMResponseError(label, `response did not match the schema — ${issues}`, text);
  }
  return parsed.data;
}

export abstract class LLMProvider {
  abstract readonly name: string;
  abstract supportsNativeSearch(): boolean;

  /** One call, one validated object. Throws `LLMResponseError` on a bad response. */
  abstract complete<T>(req: CompletionRequest<T>): Promise<T>;

  /**
   * Queries the provider issued during native web search (Claude
   * `web_search_20250305`, OpenAI `web_search_preview`). Read AFTER the call
   * completes. Default: empty array (provider didn't use native search). Stored
   * by the caller into the analysis cache for debug/inspection in the UI.
   */
  protected _nativeSearchQueries: string[] = [];
  getNativeSearchQueries(): string[] { return [...this._nativeSearchQueries]; }
}
