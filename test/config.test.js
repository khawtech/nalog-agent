import { test } from 'node:test';
import assert from 'node:assert/strict';

test('config exports expected shape', async () => {
  const { default: config } = await import('../src/config.js');
  assert.equal(typeof config.port, 'number');
  assert.equal(typeof config.dashscope, 'object');
  assert.ok(config.dashscope.models.router, 'should have a router model');
  assert.ok(config.dashscope.models.chat, 'should have a chat model');
  assert.ok(config.dashscope.models.reason, 'should have a reason model');
  assert.equal(typeof config.storage.driver, 'string');
  assert.equal(typeof config.vector.driver, 'string');
  assert.ok(['local', 'alibaba'].includes(config.storage.driver));
  assert.ok(['local', 'dashvector'].includes(config.vector.driver));
});

test('config defaults when env is empty', async () => {
  const { default: config } = await import('../src/config.js');
  assert.equal(config.dashscope.embeddingDim, 1024);
  assert.equal(config.requireHumanApproval, true);
  assert.ok(config.dashscope.baseUrl.includes('dashscope'));
});
