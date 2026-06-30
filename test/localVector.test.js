import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import LocalVector from '../src/memory/vector/localVector.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-vec-'));
}

test('upsert and query returns ranked results', async () => {
  const vec = await new LocalVector(tmpDir()).init();
  await vec.upsert('a', [1, 0, 0], { farmerId: 'f1' });
  await vec.upsert('b', [0, 1, 0], { farmerId: 'f1' });
  await vec.upsert('c', [0.9, 0.1, 0], { farmerId: 'f1' });

  const results = await vec.query([1, 0, 0], { topK: 3, filter: { farmerId: 'f1' } });
  assert.equal(results.length, 3);
  assert.equal(results[0].id, 'a');
  assert.equal(results[1].id, 'c');
});

test('filter excludes non-matching documents', async () => {
  const vec = await new LocalVector(tmpDir()).init();
  await vec.upsert('a', [1, 0], { farmerId: 'f1' });
  await vec.upsert('b', [1, 0], { farmerId: 'f2' });

  const results = await vec.query([1, 0], { topK: 10, filter: { farmerId: 'f1' } });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'a');
});

test('delete removes document', async () => {
  const vec = await new LocalVector(tmpDir()).init();
  await vec.upsert('a', [1, 0], {});
  await vec.delete('a');
  const results = await vec.query([1, 0], { topK: 5 });
  assert.equal(results.length, 0);
});

test('persistence survives reload', async () => {
  const dir = tmpDir();
  const v1 = await new LocalVector(dir).init();
  await v1.upsert('persist', [0.5, 0.5], { tag: 'test' });

  const v2 = await new LocalVector(dir).init();
  const results = await v2.query([0.5, 0.5], { topK: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'persist');
});
