import OpenAI from 'openai';
import { CompletionRequest, LLMProvider, LLMTruncatedError, parseStructured } from './base.js';
import { taskAlias, plainModel } from '../llm/gateway.js';
import type { ModelTask } from '../models.js';
import { logger } from '../utils/logger.js';

/**
 * A task's call through the LiteLLM proxy (`src/llm/gateway.ts`): the
 * OpenAI-shaped chat endpoint, the task's name as the model, JSON as the
 * answer. The proxy says in its headers which model answered and what it
 * cost. When the proxy cannot be reached at all — no answer, or its gateway
 * errors — the call goes to the provider directly, with the administration's
 * model, so that a night's run does not stop with the proxy.
 */
export class LiteLLMProvider extends LLMProvider {
  readonly name = 'litellm';
  private client: OpenAI;

  constructor(
    baseUrl: string, apiKey: string, private task: ModelTask,
    /** The direct call, for when the proxy is down; null where there is none. */
    private direct: () => LLMProvider | null,
  ) {
    super();
    this.client = new OpenAI({ apiKey, baseURL: `${baseUrl}/v1`, maxRetries: 1 });
  }

  supportsNativeSearch(): boolean { return false; }

  async complete<T>(req: CompletionRequest<T>): Promise<T> {
    const model = taskAlias(this.task);
    logger.step(`Calling ${model} via LiteLLM (${req.label})...`);
    let reply;
    try {
      reply = await this.client.chat.completions.create({
        model,
        max_completion_tokens: req.maxTokens ?? 2048,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user',   content: req.user },
        ],
      }).withResponse();
    } catch (e) {
      const unreachable = e instanceof OpenAI.APIConnectionError
        || (e instanceof OpenAI.APIError && [502, 503, 504].includes(e.status ?? 0));
      const direct = unreachable ? this.direct() : null;
      if (!direct) throw e;
      logger.warn(`LiteLLM unreachable (${(e as Error).message}) — ${req.label} goes to the provider directly`);
      const out = await direct.complete(req);
      this.usedModel = direct.usedModel;
      this.costUsd = null;
      return out;
    }
    const { data: completion, response } = reply;
    const routed = response.headers.get('x-litellm-model-name');
    const cost = Number(response.headers.get('x-litellm-response-cost'));
    this.usedModel = routed ? plainModel(routed) : model;
    this.costUsd = Number.isFinite(cost) ? cost : null;

    const choice = completion.choices[0];
    const text = choice?.message?.content ?? '';
    if (choice?.finish_reason === 'length') throw new LLMTruncatedError(req.label, req.maxTokens, text);
    logger.debug(`LiteLLM raw response (${req.label}, ${this.usedModel}):`, text.substring(0, 200));
    return parseStructured(text, req.schema, req.label);
  }
}
