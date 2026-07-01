import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import LocalStore from '../src/memory/store/localStore.js';
import LocalVector from '../src/memory/vector/localVector.js';
import { MemoryManager, currentSeason } from '../src/memory/memoryManager.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-mm-'));
}

async function makeManager() {
  const dir = tmp();
  const store = await new LocalStore(dir).init();
  const vector = await new LocalVector(dir).init();
  return new MemoryManager(store, vector);
}

test('currentSeason returns wet/dry label', () => {
  assert.match(currentSeason(new Date('2026-07-01')), /^\d{4}-wet$/);
  assert.match(currentSeason(new Date('2026-01-01')), /^\d{4}-dry$/);
});

test('record then recall returns the memory', async () => {
  const mm = await makeManager();
  await mm.recordEpisodic({
    farmerId: 'f1',
    paddyId: 'p1',
    type: 'observation',
    text: 'Paddy 3 drains to -15cm in four days',
  });
  const recalled = await mm.recall({ farmerId: 'f1', paddyId: 'p1', query: 'how fast does paddy drain', limit: 5 });
  assert.equal(recalled.length, 1);
  assert.ok(recalled[0].text.includes('drains'));
  assert.ok(typeof recalled[0].score === 'number');
});

test('reinforce increments reinforcement count', async () => {
  const mm = await makeManager();
  const mem = await mm.recordEpisodic({ farmerId: 'f1', type: 'outcome', text: 'water saved 31%' });
  await mm.reinforce([mem]);
  const [recalled] = await mm.recall({ farmerId: 'f1', query: '', limit: 5 });
  assert.equal(recalled.reinforcement, 1);
});

test('buildContext summarises profile and memories', async () => {
  const mm = await makeManager();
  await mm.setProfileFact('f1', 'preferred_language', 'th', 0.9);
  await mm.recordEpisodic({ farmerId: 'f1', paddyId: 'p1', type: 'preference', text: 'prefers manual approval' });
  const ctx = await mm.buildContext({ farmerId: 'f1', paddyId: 'p1', query: 'approval', limit: 5 });
  assert.match(ctx.text, /preferred_language/);
  assert.match(ctx.text, /manual approval/);
});

test('learnFromConversation extracts and stores memories', async () => {
  const mm = await makeManager();
  const mockExtract = async () => ({
    profileFacts: [{ key: 'preferred_language', value: 'th', confidence: 0.9 }],
    episodic: [{ type: 'observation', text: 'Paddy 3 drains fast after levelling' }],
  });
  const result = await mm.learnFromConversation(
    { farmerId: 'f1', paddyId: 'p1', transcript: 'Farmer: my field drains quickly\nAgent: noted' },
    mockExtract
  );
  assert.equal(result.profileFacts.length, 1);
  assert.equal(result.episodic.length, 1);

  const profile = await mm.getProfile('f1');
  assert.equal(profile.preferred_language.value, 'th');

  const memories = await mm.recall({ farmerId: 'f1', query: 'drain', limit: 5 });
  assert.equal(memories.length, 1);
  assert.ok(memories[0].text.includes('drains'));
});

test('learnFromConversation deduplicates near-identical memories', async () => {
  const mm = await makeManager();
  const mockExtract = async () => ({
    profileFacts: [],
    episodic: [{ type: 'observation', text: 'Paddy 3 drains fast after levelling' }],
  });
  await mm.learnFromConversation({ farmerId: 'f1', paddyId: 'p1', transcript: 'turn 1' }, mockExtract);
  const result = await mm.learnFromConversation({ farmerId: 'f1', paddyId: 'p1', transcript: 'turn 2' }, mockExtract);

  assert.equal(result.episodic.length, 0, 'duplicate should be reinforced, not re-created');

  const memories = await mm.recall({ farmerId: 'f1', query: 'drain', limit: 10 });
  assert.equal(memories.length, 1, 'only one memory should exist');
  assert.ok(memories[0].reinforcement >= 1, 'existing memory should be reinforced');
});

test('learnFromConversation handles empty transcript', async () => {
  const mm = await makeManager();
  const result = await mm.learnFromConversation({ farmerId: 'f1', transcript: '' });
  assert.deepEqual(result, { profileFacts: [], episodic: [] });
});

test('learnFromConversation handles extraction failure', async () => {
  const mm = await makeManager();
  const failExtract = async () => { throw new Error('API down'); };
  const result = await mm.learnFromConversation({ farmerId: 'f1', transcript: 'some talk' }, failExtract);
  assert.deepEqual(result, { profileFacts: [], episodic: [] });
});

test('purgeExpired removes expired memories and their vectors', async () => {
  const dir = tmp();
  const store = await new LocalStore(dir).init();
  const vector = await new LocalVector(dir).init();
  const mm = new MemoryManager(store, vector);

  await mm.recordEpisodic({
    farmerId: 'f1',
    type: 'observation',
    text: 'this will expire',
    ttlDays: -1,
  });

  assert.equal(Object.keys(store.db.episodic).length, 1);
  assert.equal(vector.docs.size, 1);

  const count = await mm.purgeExpired();
  assert.equal(count, 1);
  assert.equal(Object.keys(store.db.episodic).length, 0);
  assert.equal(vector.docs.size, 0);
});
