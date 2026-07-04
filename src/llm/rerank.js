// ──────────────────────────────────────────────────────────────────────────
// DashScope semantic reranker (qwen3-rerank on Alibaba Cloud Model Studio).
//
// Vector recall (DashVector ANN) is fast but approximate: it embeds the query
// once and ranks by cosine distance. The reranker is a cross-encoder — it
// reads query + memory text together — so it fixes near-miss orderings before
// the top-K memories enter the context window. Fully optional: any failure
// falls back to the vector order (graceful degradation for offline dev).
// ──────────────────────────────────────────────────────────────────────────
import config from '../config.js';
import logger from '../logger.js';
import { withRetry } from './dashscope.js';

// Native DashScope API base (the rerank service is not part of the
// OpenAI-compatible surface). Derived from the configured compatible-mode URL
// so region choice (intl/Beijing) carries over.
function rerankUrl() {
  const base = config.dashscope.baseUrl.replace(/\/compatible-mode\/v1\/?$/, '');
  return `${base}/api/v1/services/rerank/text-rerank/text-rerank`;
}

/**
 * Rerank documents against a query with qwen3-rerank.
 * @param {string} query
 * @param {string[]} documents
 * @param {object} [opts]
 * @param {number} [opts.topN]
 * @param {typeof fetch} [opts.fetchFn]  Injectable for tests.
 * @returns {Promise<Array<{index:number, score:number}>|null>}
 *          Best-first, or null when reranking is unavailable (caller keeps
 *          the vector order).
 */
export async function rerank(query, documents, { topN, fetchFn = fetch } = {}) {
  const model = config.dashscope.rerankModel;
  if (!model || !config.dashscope.apiKey || !query || documents.length < 2) return null;

  try {
    const res = await withRetry(
      () =>
        fetchFn(rerankUrl(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.dashscope.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            input: { query: query.slice(0, 2000), documents: documents.map((d) => d.slice(0, 2000)) },
            parameters: { return_documents: false, top_n: topN ?? documents.length },
          }),
        }),
      { label: 'rerank', retries: 1 }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.output?.results) {
      throw new Error(`rerank failed: ${res.status} ${json.message || ''}`);
    }
    return json.output.results.map((r) => ({ index: r.index, score: r.relevance_score }));
  } catch (err) {
    logger.warn({ err: err.message }, 'rerank unavailable — falling back to vector order');
    return null;
  }
}
