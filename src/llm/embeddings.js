// ──────────────────────────────────────────────────────────────────────────
// Text embeddings via Alibaba Cloud Model Studio (DashScope).
// Used to give memories semantic recall ("what did we learn last season that
// resembles this situation?"). PROOF OF ALIBABA CLOUD: embeddings are computed
// by Qwen text-embedding models on Model Studio.
// ──────────────────────────────────────────────────────────────────────────
import { getClient } from './dashscope.js';
import config from '../config.js';
import logger from '../logger.js';

/**
 * Embed one or many strings. Returns an array of Float32 vectors.
 * @param {string|string[]} input
 * @returns {Promise<number[][]>}
 */
export async function embed(input) {
  const inputs = Array.isArray(input) ? input : [input];
  const cleaned = inputs.map((t) => (t ?? '').toString().slice(0, 2048));
  if (!config.dashscope.apiKey) {
    // Deterministic offline fallback so local dev / tests work without a key.
    logger.warn('DASHSCOPE_API_KEY missing — using deterministic local embeddings (dev only)');
    return cleaned.map((t) => pseudoEmbedding(t, config.dashscope.embeddingDim));
  }
  const res = await getClient().embeddings.create({
    model: config.dashscope.embeddingModel,
    input: cleaned,
    dimensions: config.dashscope.embeddingDim,
  });
  return res.data.map((d) => d.embedding);
}

export async function embedOne(text) {
  const [vec] = await embed(text);
  return vec;
}

// Hash-based pseudo-embedding: stable, normalized, good enough for offline
// similarity in dev/tests. Never used when a real API key is present.
function pseudoEmbedding(text, dim) {
  const vec = new Array(dim).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dim;
    vec[idx] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
