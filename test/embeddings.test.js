import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from '../src/llm/embeddings.js';

test('cosineSimilarity of identical vectors is 1', () => {
  const v = [0.5, 0.3, 0.1, 0.8];
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-10);
});

test('cosineSimilarity of orthogonal vectors is 0', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
});

test('cosineSimilarity of opposite vectors is -1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1.0) < 1e-10);
});

test('cosineSimilarity handles zero vectors gracefully', () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 1, 1]), 0);
});

test('embed returns pseudo-embeddings when no API key', async () => {
  const { embed, embedOne } = await import('../src/llm/embeddings.js');
  const vecs = await embed(['hello', 'world']);
  assert.equal(vecs.length, 2);
  assert.equal(vecs[0].length, 1024);

  const single = await embedOne('test');
  assert.equal(single.length, 1024);
  const norm = Math.sqrt(single.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1.0) < 1e-6, 'pseudo-embedding should be normalized');
});

test('pseudo-embeddings are deterministic', async () => {
  const { embedOne } = await import('../src/llm/embeddings.js');
  const a = await embedOne('paddy 3 drains fast');
  const b = await embedOne('paddy 3 drains fast');
  assert.deepEqual(a, b);
});

test('similar text produces higher similarity than unrelated text', async () => {
  const { embedOne } = await import('../src/llm/embeddings.js');
  const base = await embedOne('water level in paddy field');
  const similar = await embedOne('paddy water level sensor reading');
  const unrelated = await embedOne('price of sugarcane in Bangkok');
  const simScore = cosineSimilarity(base, similar);
  const unrelScore = cosineSimilarity(base, unrelated);
  assert.ok(simScore > unrelScore, `similar (${simScore}) should beat unrelated (${unrelScore})`);
});
