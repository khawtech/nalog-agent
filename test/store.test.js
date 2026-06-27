import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import LocalStore from '../src/memory/store/localStore.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-store-'));
}

test('profile facts round-trip', async () => {
  const store = await new LocalStore(tmpDir()).init();
  await store.setProfileFact('f1', 'preferred_language', 'th', 0.9);
  const profile = await store.getProfile('f1');
  assert.equal(profile.preferred_language.value, 'th');
  assert.equal(profile.preferred_language.confidence, 0.9);
});

test('episodic listing filters expired and by paddy', async () => {
  const store = await new LocalStore(tmpDir()).init();
  const now = new Date().toISOString();
  await store.putEpisodic({ memoryId: 'm1', farmerId: 'f1', paddyId: 'p1', text: 'a', createdAt: now });
  await store.putEpisodic({ memoryId: 'm2', farmerId: 'f1', paddyId: 'p2', text: 'b', createdAt: now });
  await store.putEpisodic({
    memoryId: 'm3',
    farmerId: 'f1',
    paddyId: 'p1',
    text: 'expired',
    createdAt: now,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  const all = await store.listEpisodic('f1');
  assert.equal(all.length, 2, 'expired memory excluded');

  const p1 = await store.listEpisodic('f1', { paddyId: 'p1' });
  assert.equal(p1.length, 1);
  assert.equal(p1[0].memoryId, 'm1');
});

test('proposals lifecycle', async () => {
  const store = await new LocalStore(tmpDir()).init();
  await store.putProposal({ proposalId: 'x1', sessionId: 's1', status: 'pending', createdAt: new Date().toISOString() });
  const pending = await store.listProposals({ status: 'pending' });
  assert.equal(pending.length, 1);
  const updated = await store.updateProposal('x1', { status: 'executed' });
  assert.equal(updated.status, 'executed');
  assert.equal((await store.listProposals({ status: 'pending' })).length, 0);
});
