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
