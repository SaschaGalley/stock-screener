/** The LiteLLM gateway: the tasks' models as the proxy names them, and a call through it. */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';

import { plainModel, taskAlias, tasksFromModelInfo } from '../src/llm/gateway.js';
import { MODEL_TASKS } from '../src/models.js';
import { LLMProvider, type CompletionRequest } from '../src/providers/base.js';
import { LiteLLMProvider } from '../src/providers/litellm.js';

describe('the tasks as the proxy names them', () => {
  it('reads each task\'s model from the model info, without the provider\'s prefix', () => {
    const tasks = tasksFromModelInfo({
      data: [
        { model_name: 'stock-cli/analysis', litellm_params: { model: 'made-up-large' } },
        { model_name: 'stock-cli/analysis', litellm_params: { model: 'made-up-other' } },
        { model_name: 'stock-cli/market-brief', litellm_params: { model: 'perplexity/sonar-pro' } },
        { model_name: 'other-project/analysis', litellm_params: { model: 'made-up-small' } },
        { model_name: 'stock-cli/summary' },
      ],
    });
    assert.deepEqual(tasks, { analysis: 'made-up-large', 'market-brief': 'sonar-pro' });
    assert.deepEqual(tasksFromModelInfo(null), {});
  });

  it('names a task stock-cli/<task>, one name per task', () => {
    assert.equal(taskAlias('depot-manager'), 'stock-cli/depot-manager');
    assert.equal(new Set(MODEL_TASKS.map((t) => t.key)).size, MODEL_TASKS.length);
    assert.equal(plainModel('anthropic/made-up-model'), 'made-up-model');
    assert.equal(plainModel('made-up-model'), 'made-up-model');
  });
});

describe('a call through the proxy', () => {
  let server: http.Server;
  let base = '';
  let status = 200;
  const seen: { model?: string; auth?: string }[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        seen.push({ model: parsed.model, auth: req.headers.authorization });
        if (status !== 200) { res.writeHead(status); res.end('{"error":"down"}'); return; }
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-litellm-model-name': 'anthropic/made-up-model',
          'x-litellm-response-cost': '0.0123',
        });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', created: 0, model: parsed.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok": true}' } }],
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => { server.close(); });

  const req: CompletionRequest<{ ok: boolean }> = { label: 'test', system: 'Answer in JSON.', user: 'ok?', schema: z.object({ ok: z.boolean() }) };

  it('asks for the task by its name and says which model answered and what it cost', async () => {
    status = 200;
    const p = new LiteLLMProvider(base, 'made-up-key', 'chart-read', () => null);
    assert.deepEqual(await p.complete(req), { ok: true });
    assert.equal(seen.at(-1)?.model, 'stock-cli/chart-read');
    assert.equal(seen.at(-1)?.auth, 'Bearer made-up-key');
    assert.equal(p.usedModel, 'made-up-model');
    assert.equal(p.costUsd, 0.0123);
  });

  it('goes to the provider directly when the proxy\'s gateway fails, and not on its own errors', async () => {
    class Direct extends LLMProvider {
      readonly name = 'direct';
      supportsNativeSearch() { return false; }
      async complete<T>(r: CompletionRequest<T>): Promise<T> { this.usedModel = 'made-up-direct'; return r.schema.parse({ ok: false }); }
    }
    status = 503;
    const p = new LiteLLMProvider(base, 'made-up-key', 'summary', () => new Direct());
    assert.deepEqual(await p.complete(req), { ok: false });
    assert.equal(p.usedModel, 'made-up-direct');
    status = 400;
    await assert.rejects(() => new LiteLLMProvider(base, 'made-up-key', 'summary', () => new Direct()).complete(req));
    status = 200;
  });
});
