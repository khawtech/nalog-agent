// These tests run in demo mode (NALOG_USE_DEMO=true set via npm test script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions, handlers } from '../src/agent/tools.js';
import LocalStore from '../src/memory/store/localStore.js';
import LocalVector from '../src/memory/vector/localVector.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-tools-'));
}

async function makeCtx() {
  const dir = tmpDir();
  const store = await new LocalStore(dir).init();
  const memory = new MemoryManager(store, await new LocalVector(dir).init());
  return {
    farmerId: 'farmer-somchai',
    sessionId: 'test-sess',
    paddyId: null,
    farmId: null,
    nalogToken: null,
    memory,
    store,
    createdProposals: [],
    recalledMemories: [],
  };
}

test('toolDefinitions is a valid OpenAI tools array', () => {
  assert.ok(Array.isArray(toolDefinitions));
  assert.ok(toolDefinitions.length >= 7);
  for (const td of toolDefinitions) {
    assert.equal(td.type, 'function');
    assert.ok(td.function.name);
    assert.ok(td.function.description);
    assert.ok(td.function.parameters);
  }
});

test('all tool definitions have matching handlers', () => {
  for (const td of toolDefinitions) {
    const name = td.function.name;
    assert.ok(handlers[name], `missing handler for tool ${name}`);
    assert.equal(typeof handlers[name], 'function');
  }
});

test('get_farm_overview returns farms with paddies', async () => {
  const ctx = await makeCtx();
  const result = await handlers.get_farm_overview({}, ctx);
  assert.ok(result.farms.length >= 1);
  assert.ok(result.farms[0].paddies.length >= 1);
});

test('get_paddy_status returns data for known paddy', async () => {
  const ctx = await makeCtx();
  const result = await handlers.get_paddy_status({ paddyId: 'paddy-rice-3' }, ctx);
  assert.ok(result.paddy);
  assert.equal(result.paddy.cropType, 'rice');
  assert.ok(result.sensors.length >= 1);
});

test('get_paddy_status returns error for unknown paddy', async () => {
  const ctx = await makeCtx();
  const result = await handlers.get_paddy_status({ paddyId: 'nonexistent' }, ctx);
  assert.ok(result.error);
});

test('get_sensor_history returns summary', async () => {
  const ctx = await makeCtx();
  const result = await handlers.get_sensor_history({ sensorId: 'sensor-awd-p3', hours: 24 }, ctx);
  assert.ok(result.points > 0);
  assert.ok(result.latest);
  assert.ok(typeof result.min === 'number');
  assert.ok(typeof result.max === 'number');
});

test('recall_memory and save_memory round-trip', async () => {
  const ctx = await makeCtx();
  await handlers.save_memory(
    { type: 'observation', text: 'Paddy 3 drains fast after levelling', paddyId: 'paddy-rice-3' },
    ctx
  );
  const result = await handlers.recall_memory({ query: 'drain speed', paddyId: 'paddy-rice-3' }, ctx);
  assert.ok(result.memories.length >= 1);
  assert.ok(result.memories[0].text.includes('drains'));
  assert.ok(ctx.recalledMemories.length >= 1);
});

test('update_profile persists the fact', async () => {
  const ctx = await makeCtx();
  await handlers.update_profile({ key: 'preferred_language', value: 'th', confidence: 0.95 }, ctx);
  const profile = await ctx.memory.getProfile('farmer-somchai');
  assert.equal(profile.preferred_language.value, 'th');
});

test('propose_irrigation creates a pending proposal', async () => {
  const ctx = await makeCtx();
  const result = await handlers.propose_irrigation(
    { paddyId: 'paddy-rice-3', action: 'on', reason: 'Water level below threshold' },
    ctx
  );
  assert.equal(result.status, 'pending_approval');
  assert.ok(result.proposalId);
  assert.equal(ctx.createdProposals.length, 1);
  assert.equal(ctx.createdProposals[0].status, 'pending');
});
