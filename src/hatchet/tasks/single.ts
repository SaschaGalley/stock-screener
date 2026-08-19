/**
 * The things a person asks for by clicking, as Hatchet tasks.
 *
 * These were the last work in the app that ran straight inside an HTTP handler,
 * and leaving them there had two costs that were not obvious from the outside:
 *
 *   - They bypassed the gates. Those count per worker process, so a Distill
 *     refresh clicked while the nightly run was going gave two concurrent calls
 *     to a machine meant to take one.
 *   - They spent Finnhub and Yahoo quota without booking it, so the rate
 *     limiter believed it had more headroom than it did.
 *
 * Both are fixed simply by the work happening in the worker like everything
 * else. What is deliberately *not* changed is the API contract: the endpoints
 * still await the result and answer with it, so the web UI is untouched. The
 * queue is in the middle now, not in the way.
 *
 * Which is only true because these run at HIGH priority. Interactive work must
 * not wait behind a nightly pass — with Distill serialised, a click during the
 * night would otherwise sit behind every remaining symbol.
 */

import type { JsonObject } from '@hatchet-dev/typescript-sdk';

import { readAppConfig } from '../../app-config.js';
import { getConfig } from '../../config.js';
import { readFinancialsLax } from '../../db/store.js';
import { distillHintsFor, syncDistillBriefing } from '../../distill-service.js';
import { refreshStockData } from '../../refresh.js';
import { runAnalysis } from '../../cli.js';
import { looksLikeSymbol } from '../../symbols.js';
import { getHatchet } from '../client.js';
import {
  analysisGate, distillGate,
  FINNHUB_UNITS_PER_SYMBOL, YAHOO_UNITS_PER_SYMBOL,
} from '../limits.js';

const hatchet = getHatchet();

// Generous, for the same reason the pipeline's are: a task holds its slot while
// queueing at a gate, so the budget covers the wait as well as the work.
const REFRESH_TIMEOUT  = '30m';
const DISTILL_TIMEOUT  = '3h';
const ANALYSIS_TIMEOUT = '2h';

// ── Data refresh ─────────────────────────────────────────────────────────────

export type RefreshDataInput = {
  symbol: string;
  /** The pipeline runs Distill as its own step; a click wants the lot. */
  includeDistill?: boolean;
};

/**
 * Task payloads are typed loosely on purpose.
 *
 * The SDK constrains input and output to a JSON object, recursively — and the
 * domain types these carry are interfaces, which do not satisfy an index
 * signature however they are wrapped. Since the value really is JSON by the
 * time it crosses this boundary (Hatchet serialises it either way), the cast
 * states that rather than reshaping the domain types to please the constraint.
 *
 * The endpoints spread these straight into their responses, so the shape the
 * web UI sees is unchanged.
 */
type JsonPayload = JsonObject;

export type RefreshDataOutput = {
  data: JsonPayload;
  /** The ticker the refresh actually resolved to, which may be tidier than the
   *  one handed in — callers name the stock by it. */
  symbol: string;
};

export const refreshData = hatchet.task<RefreshDataInput, RefreshDataOutput>({
  name:    'refresh-data',
  retries: 2,
  executionTimeout: REFRESH_TIMEOUT,
  rateLimits: [
    { staticKey: 'finnhub', units: FINNHUB_UNITS_PER_SYMBOL },
    { staticKey: 'yahoo',   units: YAHOO_UNITS_PER_SYMBOL },
  ],
  // Returned whole: the endpoint answers with it, and re-reading it from the
  // database afterwards would be a second round trip for data we just held.
  fn: async (input): Promise<RefreshDataOutput> => {
    const data = await refreshStockData(
      input.symbol, { includeDistill: input.includeDistill ?? true },
    );
    return { data: data as unknown as JsonPayload, symbol: data.symbol };
  },
});

// ── Distill refresh ──────────────────────────────────────────────────────────

export type DistillRefreshInput = { symbol: string };

export type DistillRefreshOutput = { result: JsonPayload };

export const distillRefresh = hatchet.task<DistillRefreshInput, DistillRefreshOutput>({
  name:    'distill-refresh',
  retries: 2,
  executionTimeout: DISTILL_TIMEOUT,
  scheduleTimeout:  DISTILL_TIMEOUT,
  fn: async (input): Promise<DistillRefreshOutput> => {
    const cfg = getConfig();
    if (!cfg.distillApiKey) throw new Error('Distill not configured — set DISTILL_API_KEY.');

    return distillGate.run(async () => {
      const financials = await readFinancialsLax(input.symbol);
      const result = await syncDistillBriefing(
        distillHintsFor(input.symbol, financials),
        cfg.distillApiKey!,
        cfg.distillApiUrl,
        cfg.distillBriefingTypeId,
        'refresh',
      );
      return { result: result as unknown as JsonPayload };
    });
  },
});

// ── Analysis ─────────────────────────────────────────────────────────────────

export type AnalyzeInput = {
  /** Ticker or company name. Which of the two is decided here, by the same
   *  `looksLikeSymbol` the endpoint used to call — one rule, one place. */
  input:   string;
  model?:  string;
  /** Accepts the same shapes `runAnalysis` does: a name, a comma-separated
   *  list, an array, or the string 'none'. */
  search?: string | string[];
  pplx?:   'sonar' | 'sonar-pro' | null;
  force?:  boolean;
};

export type AnalyzeOutput = { result: JsonPayload; meta: JsonPayload };

export const analyze = hatchet.task<AnalyzeInput, AnalyzeOutput>({
  name:    'analyze',
  // One. A rejected analysis is usually a bad model id or an unresolvable
  // symbol, and repeating an LLM call that costs money to fail the same way
  // twice helps nobody.
  retries: 1,
  executionTimeout: ANALYSIS_TIMEOUT,
  scheduleTimeout:  ANALYSIS_TIMEOUT,
  fn: async (input, ctx): Promise<AnalyzeOutput> => {
    const config = await readAppConfig();
    return analysisGate.run(async () => {
      const target = looksLikeSymbol(input.input)
        ? { symbol: input.input.toUpperCase() }
        : { query: input.input };
      const { result, meta } = await runAnalysis({
        ...target,
        model:   input.model ?? config.steps.analysis.model,
        search:  input.search ?? 'none',
        pplx:    input.pplx ?? null,
        force:   input.force ?? false,
        verbose: false,
        // Progress leaves the worker the only way it can reach a browser that
        // is connected to the API rather than to us: over the run's stream,
        // which the API subscribes to and forwards as SSE. Fire-and-forget —
        // an analysis must not fail because a progress line did not land.
        onProgress: (ev) => { void ctx.putStream(JSON.stringify(ev)); },
      });
      return { result: result as unknown as JsonPayload, meta: meta as unknown as JsonPayload };
    });
  },
});
