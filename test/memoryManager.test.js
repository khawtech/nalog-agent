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

test('recall cleans up orphan vector entries (vector-first path)', async () => {
  const dir = tmp();
  const store = await new LocalStore(dir).init();
  const vector = await new LocalVector(dir).init();
  const mm = new MemoryManager(store, vector);

  await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'paddy drains fast' });
  // Simulate a Tablestore-TTL-deleted row: vector entry without a store row.
  const { embedOne } = await import('../src/llm/embeddings.js');
  await vector.upsert('orphan-id', await embedOne('observation: stale memory'), { farmerId: 'f1', memoryId: 'orphan-id' });
  assert.equal(vector.docs.size, 2);

  const recalled = await mm.recall({ farmerId: 'f1', query: 'paddy drains', limit: 5 });
  assert.equal(recalled.length, 1, 'only the live memory is recalled');

  await new Promise((r) => setTimeout(r, 20)); // orphan cleanup is fire-and-forget
  assert.equal(vector.docs.size, 1, 'orphan vector entry was deleted');
  assert.ok(vector.docs.has(recalled[0].memoryId));
});

test('recall falls back to stored memories when the vector index is empty', async () => {
  const dir = tmp();
  const store = await new LocalStore(dir).init();
  const vector = await new LocalVector(dir).init();
  const mm = new MemoryManager(store, vector);

  // Store row exists but vector upsert never happened (e.g. embed outage).
  await store.putEpisodic({
    memoryId: 'm-novector',
    farmerId: 'f1',
    paddyId: null,
    type: 'observation',
    text: 'stored without a vector',
    structured: {},
    season: currentSeason(),
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    reinforcement: 0,
    expiresAt: null,
  });

  const recalled = await mm.recall({ farmerId: 'f1', query: 'anything at all', limit: 5 });
  assert.equal(recalled.length, 1, 'graceful degradation to store listing');
  assert.equal(recalled[0].memoryId, 'm-novector');
});

test('supersede marks old memory and recall excludes it', async () => {
  const mm = await makeManager();
  const old = await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'Farmer uses diesel pump' });
  const fresh = await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'Farmer switched to electric pump' });

  await mm.supersede('f1', old.memoryId, fresh.memoryId, 'contradiction');
  const recalled = await mm.recall({ farmerId: 'f1', query: 'what pump does the farmer use', limit: 10 });

  assert.ok(recalled.every((m) => m.memoryId !== old.memoryId), 'superseded memory excluded from recall');
  assert.ok(recalled.some((m) => m.memoryId === fresh.memoryId), 'fresh memory still returned');
});

test('superseded memory is still in store for auditability', async () => {
  const mm = await makeManager();
  const old = await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'AWD trigger at -20cm' });
  const fresh = await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'AWD trigger at -15cm' });

  await mm.supersede('f1', old.memoryId, fresh.memoryId, 'updated');
  const rows = await mm.store.getEpisodicByIds('f1', [old.memoryId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].supersededBy, fresh.memoryId);
  assert.ok(rows[0].supersededAt);
});

test('adjudicateMemory returns supersedes for contradictions', async () => {
  const mm = await makeManager();
  const mockLLM = async () => ({ verdict: 'supersedes', reason: 'pump type changed' });
  const result = await mm.adjudicateMemory('diesel pump', 'electric pump', mockLLM);
  assert.equal(result, 'supersedes');
});

test('adjudicateMemory returns distinct for unrelated facts', async () => {
  const mm = await makeManager();
  const mockLLM = async () => ({ verdict: 'distinct', reason: 'different topics' });
  const result = await mm.adjudicateMemory('diesel pump', 'pest damage', mockLLM);
  assert.equal(result, 'distinct');
});

test('adjudicateMemory returns distinct on LLM failure', async () => {
  const mm = await makeManager();
  const failLLM = async () => { throw new Error('API down'); };
  const result = await mm.adjudicateMemory('diesel pump', 'electric pump', failLLM);
  assert.equal(result, 'distinct');
});

test('learnFromConversation supersedes contradictions via adjudication', async () => {
  const mm = await makeManager();

  // Existing memory: AWD trigger at -20cm (old, wrong)
  await mm.recordEpisodic({
    farmerId: 'f1',
    type: 'observation',
    text: 'Farmer set AWD trigger to minus 20cm',
  });

  let callCount = 0;
  const mockExtract = async () => {
    callCount++;
    if (callCount === 1) {
      // Extraction: new contradicting fact (sim ~0.64 — in adjudication range)
      return {
        profileFacts: [],
        episodic: [{ type: 'observation', text: 'Farmer changed AWD trigger to minus 15cm after good results' }],
      };
    }
    // Adjudication: LLM says supersedes
    return { verdict: 'supersedes', reason: 'trigger depth updated' };
  };

  const result = await mm.learnFromConversation(
    { farmerId: 'f1', paddyId: 'p1', transcript: 'Farmer: changed trigger\nAgent: noted' },
    mockExtract
  );

  assert.equal(result.episodic.length, 1, 'new memory was saved');

  const recalled = await mm.recall({ farmerId: 'f1', query: 'AWD trigger depth', limit: 10 });
  const texts = recalled.map((m) => m.text);
  assert.ok(texts.some((t) => t.includes('minus 15cm')), 'new fact is recalled');
  assert.ok(!texts.some((t) => t.includes('minus 20cm')), 'old contradicted fact is excluded');
});

test('safety rescue floor: highly reinforced memories surface even below top-K', async () => {
  const mm = await makeManager();
  // Create 10 memories about a specific topic to fill the top-K
  for (let i = 0; i < 10; i++) {
    await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: `Diesel pump maintenance note number ${i} for the tractor shed` });
  }
  // Create a safety-critical memory on a completely different topic
  const critical = await mm.recordEpisodic({ farmerId: 'f1', type: 'preference', text: 'CRITICAL flowering flood rule absolutely strict requirement always keep water level above zero' });
  // Reinforce to safety level (≥5)
  for (let i = 0; i < 5; i++) {
    await mm.store.touchEpisodic(critical, { reinforce: true });
  }

  const recalled = await mm.recall({ farmerId: 'f1', query: 'diesel pump maintenance tractor', limit: 5 });
  assert.ok(recalled.length > 5, 'more than 5 returned because critical memory was rescued');
  const criticalRecalled = recalled.find((m) => m.text.includes('flowering flood rule'));
  assert.ok(criticalRecalled, 'safety-critical memory is rescued into results');
  assert.ok(criticalRecalled._rescued, 'rescued flag is set');
});

test('recallWithTrace returns trace metadata', async () => {
  const mm = await makeManager();
  await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'Paddy 3 drains fast' });
  await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'Paddy 2 has pest issues' });

  const old = await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'Old fact about drainage' });
  const fresh = await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'Updated drainage info' });
  await mm.supersede('f1', old.memoryId, fresh.memoryId, 'updated');

  const result = await mm.recallWithTrace({ farmerId: 'f1', query: 'drainage', limit: 3 });
  assert.ok(result.memories.length > 0);
  assert.ok(result.trace);
  assert.ok(result.trace.candidatesConsidered > 0);
  assert.equal(result.trace.supersededExcluded, 1);
  assert.ok(Array.isArray(result.trace.memories));
  assert.ok(result.trace.memories[0].memoryId);
  assert.ok(typeof result.trace.memories[0].score === 'number');
});

test('buildContext includes memoryTrace', async () => {
  const mm = await makeManager();
  await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'test memory' });
  const ctx = await mm.buildContext({ farmerId: 'f1', query: 'test', limit: 5 });
  assert.ok(ctx.memoryTrace, 'buildContext returns trace');
  assert.ok(ctx.memoryTrace.candidatesConsidered >= 1);
  assert.ok(ctx.memoryTrace.memories.length >= 1);
});

test('learnFromConversation returns diff stats', async () => {
  const mm = await makeManager();
  const mockExtract = async () => ({
    profileFacts: [{ key: 'lang', value: 'th', confidence: 0.9 }],
    episodic: [
      { type: 'observation', text: 'New drainage observation' },
      { type: 'preference', text: 'Prefers morning pumping' },
    ],
  });
  const result = await mm.learnFromConversation(
    { farmerId: 'f1', paddyId: 'p1', transcript: 'some talk' },
    mockExtract
  );
  assert.ok(result.diff);
  assert.equal(result.diff.newMemories, 2);
  assert.equal(result.diff.profileUpdates, 1);
  assert.equal(typeof result.diff.reinforced, 'number');
  assert.equal(typeof result.diff.superseded, 'number');
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

  const result = await mm.purgeExpired();
  assert.equal(result.purged, 1);
  assert.equal(Object.keys(store.db.episodic).length, 0);
  assert.equal(vector.docs.size, 0);
});

test('consolidate compresses multiple memories into a summary', async () => {
  const mm = await makeManager();
  const m1 = await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'Paddy 3 drains in 4 days' });
  const m2 = await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'Paddy 3 needs reflooding after 5 days' });

  const mockLLM = async () => ({
    summary: 'Paddy 3 drains in 4 days and needs reflooding after 5 days',
    retained_facts: ['drain speed: 4 days', 'reflood interval: 5 days'],
  });

  const result = await mm.consolidate('f1', [m1, m2], mockLLM);
  assert.ok(result);
  assert.equal(result.type, 'consolidated');
  assert.ok(result.text.includes('drains'));
  assert.equal(result.structured.originalCount, 2);
  assert.equal(result.structured.consolidatedFrom.length, 2);
});

test('consolidate returns null on LLM failure', async () => {
  const mm = await makeManager();
  const m1 = await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'some memory' });
  const failLLM = async () => { throw new Error('API down'); };
  const result = await mm.consolidate('f1', [m1], failLLM);
  assert.equal(result, null);
});

test('keyword scoring boosts exact term matches in recall', async () => {
  const mm = await makeManager();
  await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'electric pump installed on paddy 3' });
  await mm.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'general farm maintenance note about equipment' });

  const recalled = await mm.recallWithTrace({ farmerId: 'f1', query: 'electric pump paddy', limit: 5 });
  assert.ok(recalled.memories.length > 0);
  const pumpMemory = recalled.memories.find((m) => m.text.includes('electric pump'));
  assert.ok(pumpMemory, 'memory with keyword match should be recalled');
  const traceEntry = recalled.trace.memories.find((t) => t.memoryId === pumpMemory.memoryId);
  assert.ok(traceEntry.keyword > 0, 'keyword score should be positive for matching terms');
});
