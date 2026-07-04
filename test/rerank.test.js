import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { rerank } from '../src/llm/rerank.js';

const originalKey = config.dashscope.apiKey;
const originalModel = config.dashscope.rerankModel;

afterEach(() => {
  config.dashscope.apiKey = originalKey;
  config.dashscope.rerankModel = originalModel;
});

test('rerank returns null without an API key (offline fallback)', async () => {
  config.dashscope.apiKey = '';
  config.dashscope.rerankModel = 'qwen3-rerank';
  const out = await rerank('query', ['a', 'b']);
  assert.equal(out, null);
});

test('rerank returns null when disabled via RERANK_MODEL=', async () => {
  config.dashscope.apiKey = 'sk-test';
  config.dashscope.rerankModel = '';
  const out = await rerank('query', ['a', 'b']);
  assert.equal(out, null);
});

test('rerank parses DashScope results best-first', async () => {
  config.dashscope.apiKey = 'sk-test';
  config.dashscope.rerankModel = 'qwen3-rerank';
  let calledUrl = null;
  let sentBody = null;
  const fetchFn = async (url, opts) => {
    calledUrl = url;
    sentBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output: { results: [{ index: 2, relevance_score: 0.91 }, { index: 0, relevance_score: 0.42 }] },
      }),
    };
  };
  const out = await rerank('drains fast', ['pump events', 'language pref', 'Paddy 3 drains to -15cm in 4 days'], { fetchFn });
  assert.match(calledUrl, /dashscope.*\/api\/v1\/services\/rerank\/text-rerank\/text-rerank/);
  assert.equal(sentBody.model, 'qwen3-rerank');
  assert.equal(sentBody.input.documents.length, 3);
  assert.deepEqual(out, [
    { index: 2, score: 0.91 },
    { index: 0, score: 0.42 },
  ]);
});

test('rerank degrades to null on API failure', async () => {
  config.dashscope.apiKey = 'sk-test';
  config.dashscope.rerankModel = 'qwen3-rerank';
  const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) });
  const out = await rerank('q', ['a', 'b'], { fetchFn });
  assert.equal(out, null);
});
