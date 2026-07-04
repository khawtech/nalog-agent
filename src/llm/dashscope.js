// ──────────────────────────────────────────────────────────────────────────
// Alibaba Cloud Model Studio (DashScope) — Qwen client.
//
// PROOF OF ALIBABA CLOUD: all language reasoning in this project is served by
// Qwen models hosted on Alibaba Cloud Model Studio, called through the
// OpenAI-compatible endpoint at dashscope-intl.aliyuncs.com.
//
// We expose four tiers so the agent spends tokens deliberately:
//   - router : cheap/fast extraction & routing        (qwen3.6-flash)
//   - chat   : Thai/English natural language generation (qwen3.6-plus)
//   - reason : agronomic decisions & tool use, thinking (qwen3.7-max)
//   - vision : paddy photo analysis                    (qwen3-vl-plus)
//
// Qwen hybrid thinking: the reason tier keeps thinking mode on (deep tool-use
// reasoning); chat/router disable it for latency and cost. Streaming is
// supported for both content and reasoning deltas (SSE to the farmer UI).
// ──────────────────────────────────────────────────────────────────────────
import OpenAI from 'openai';
import config from '../config.js';
import logger from '../logger.js';

let _client;
function getClient() {
  if (!_client) {
    _client = new OpenAI({
      apiKey: config.dashscope.apiKey || 'unused',
      baseURL: config.dashscope.baseUrl,
      maxRetries: 0, // we run our own retry with logging
    });
  }
  return _client;
}

// Process-wide token tally (ops metric). Per-turn accounting uses the `usage`
// collector param so concurrent requests never pollute each other's numbers.
const usageTotals = { prompt: 0, completion: 0, total: 0, calls: 0 };

function track(usage, collector) {
  if (!usage) return;
  for (const t of [usageTotals, collector].filter(Boolean)) {
    t.prompt += usage.prompt_tokens || 0;
    t.completion += usage.completion_tokens || 0;
    t.total += usage.total_tokens || 0;
    t.calls += 1;
  }
}

export function getUsageTotals() {
  return { ...usageTotals };
}

/** Fresh per-turn usage collector. Pass to chat() calls belonging to one turn. */
export function newUsageCollector() {
  return { prompt: 0, completion: 0, total: 0, calls: 0 };
}

export function resolveModel(tier = 'chat') {
  return config.dashscope.models[tier] || config.dashscope.models.chat;
}

const RETRYABLE = /(?:429|5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up)/i;

async function withRetry(fn, { label, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = `${err.status || ''} ${err.message || err}`;
      if (attempt === retries || !RETRYABLE.test(msg)) throw err;
      const delay = 500 * 2 ** attempt + Math.random() * 250;
      logger.warn({ label, attempt: attempt + 1, delay: Math.round(delay), err: err.message }, 'retrying DashScope call');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Chat completion against a Qwen model on Model Studio.
 * @param {object} opts
 * @param {'router'|'chat'|'reason'|'vision'} [opts.tier]
 * @param {Array} opts.messages       OpenAI-style message array
 * @param {Array} [opts.tools]        OpenAI tool definitions (function calling)
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {object} [opts.responseFormat]
 * @param {object} [opts.usage]       Per-turn usage collector (newUsageCollector())
 * @param {boolean} [opts.stream]     Stream deltas; requires onDelta for output
 * @param {(delta: {content?: string, reasoning?: string}) => void} [opts.onDelta]
 * @param {boolean} [opts.enableThinking]  Override the tier's thinking policy
 * @returns {Promise<object>} the assistant message (assembled when streaming)
 */
export async function chat({
  tier = 'chat',
  messages,
  tools,
  temperature = 0.3,
  maxTokens,
  responseFormat,
  usage: usageCollector,
  stream = false,
  onDelta,
  enableThinking,
} = {}) {
  if (!config.dashscope.apiKey) {
    throw new Error(
      'DASHSCOPE_API_KEY is not set. Get one at https://bailian.console.alibabacloud.com/#/api_key'
    );
  }
  const model = resolveModel(tier);
  const params = { model, messages, temperature };
  if (tools?.length) {
    params.tools = tools;
    params.tool_choice = 'auto';
  }
  if (maxTokens) params.max_tokens = maxTokens;
  if (responseFormat) params.response_format = responseFormat;
  // Hybrid-thinking control is a Qwen3-specific request field.
  if (/^qwen3/.test(model)) {
    params.enable_thinking = enableThinking ?? config.dashscope.thinkingTiers.includes(tier);
  }

  const started = Date.now();
  try {
    let message;
    if (stream) {
      message = await withRetry(
        () => streamCompletion(params, { onDelta, usageCollector }),
        { label: `${tier}:stream` }
      );
    } else {
      const completion = await withRetry(
        () => getClient().chat.completions.create(params),
        { label: tier }
      );
      track(completion.usage, usageCollector);
      message = completion.choices[0]?.message ?? { role: 'assistant', content: '' };
    }
    logger.debug({ model, tier, ms: Date.now() - started, stream }, 'qwen completion');
    return message;
  } catch (err) {
    logger.error({ err: err.message, model, tier }, 'qwen completion failed');
    throw err;
  }
}

/** Consume a streaming completion, emitting deltas and assembling the message. */
async function streamCompletion(params, { onDelta, usageCollector }) {
  const streamResp = await getClient().chat.completions.create({
    ...params,
    stream: true,
    stream_options: { include_usage: true },
  });

  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  for await (const chunk of streamResp) {
    if (chunk.usage) track(chunk.usage, usageCollector);
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      message.content += delta.content;
      onDelta?.({ content: delta.content });
    }
    if (delta.reasoning_content) {
      onDelta?.({ reasoning: delta.reasoning_content });
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      if (!toolCalls[idx]) {
        toolCalls[idx] = {
          id: tc.id || `call_${idx}`,
          type: 'function',
          function: { name: '', arguments: '' },
        };
      }
      if (tc.id) toolCalls[idx].id = tc.id;
      if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
      if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
    }
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls.filter(Boolean);
  return message;
}

/**
 * Ask a Qwen model for strict JSON and parse it. Falls back to extracting the
 * first {...} block if the model wraps the JSON in prose.
 */
export async function chatJSON(opts) {
  const message = await chat({
    ...opts,
    responseFormat: { type: 'json_object' },
  });
  const raw = message.content || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
    logger.warn({ raw }, 'failed to parse JSON from Qwen, returning empty object');
    return {};
  }
}

export { getClient, withRetry };
