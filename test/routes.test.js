import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import LocalStore from '../src/memory/store/localStore.js';
import LocalVector from '../src/memory/vector/localVector.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-routes-'));
}

async function setup() {
  const dir = tmpDir();
  const store = await new LocalStore(dir).init();
  const memory = new MemoryManager(store, await new LocalVector(dir).init());
  const agent = { run: async () => ({ sessionId: 'test-session', message: 'test reply', proposals: [], toolTrace: [], memoryUsed: [], usage: { turnTokens: 42, totalTokens: 42 } }) };
  const app = buildApp({ agent, memory, store });
  return { app, store, memory };
}

async function request(app, method, url, body = null, headers = {}) {
  const { default: http } = await import('node:http');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const opts = { method, hostname: '127.0.0.1', port, path: url, headers: { ...headers } };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
  }

  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        server.close();
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (err) => { server.close(); reject(err); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('GET /healthz returns ok status', async () => {
  const { app } = await setup();
  const res = await request(app, 'GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.service, 'nalog-agent');
  assert.ok(res.body.models);
  assert.ok(res.body.time);
});

test('POST /api/chat rejects empty message', async () => {
  const { app } = await setup();
  const res = await request(app, 'POST', '/api/chat', { message: '' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /message/i);
});

test('POST /api/chat rejects missing message', async () => {
  const { app } = await setup();
  const res = await request(app, 'POST', '/api/chat', {});
  assert.equal(res.status, 400);
});

test('POST /api/chat rejects overly long message', async () => {
  const { app } = await setup();
  const res = await request(app, 'POST', '/api/chat', { message: 'x'.repeat(4001) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /long/i);
});

test('POST /api/chat succeeds with valid message', async () => {
  const { app } = await setup();
  const res = await request(app, 'POST', '/api/chat', { message: 'Hello' });
  assert.equal(res.status, 200);
  assert.ok(res.body.sessionId);
  assert.equal(res.body.message, 'test reply');
});

test('GET /api/memory returns profile and memories', async () => {
  const { app, memory } = await setup();
  await memory.setProfileFact('farmer-somchai', 'preferred_language', 'th', 0.9);
  const res = await request(app, 'GET', '/api/memory');
  assert.equal(res.status, 200);
  assert.ok(res.body.profile);
  assert.ok(Array.isArray(res.body.memories));
});

test('GET /api/proposals/:id returns 404 for unknown proposal', async () => {
  const { app } = await setup();
  const res = await request(app, 'GET', '/api/proposals/nonexistent');
  assert.equal(res.status, 404);
});

test('proposals approve/reject lifecycle', async () => {
  const { app, store } = await setup();
  await store.putProposal({
    proposalId: 'test-prop',
    sessionId: 's1',
    farmerId: 'farmer-somchai',
    paddyId: 'paddy-rice-3',
    paddyName: 'Paddy 3',
    action: 'on',
    reason: 'test',
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  const approve = await request(app, 'POST', '/api/proposals/test-prop/approve', {});
  assert.equal(approve.status, 200);
  assert.equal(approve.body.ok, true);

  const again = await request(app, 'POST', '/api/proposals/test-prop/approve', {});
  assert.equal(again.status, 409);
});

test('proposal reject records preference memory', async () => {
  const { app, store, memory } = await setup();
  await store.putProposal({
    proposalId: 'rej-prop',
    sessionId: 's2',
    farmerId: 'farmer-somchai',
    paddyId: 'paddy-rice-3',
    paddyName: 'Paddy 3',
    action: 'on',
    reason: 'test rejection',
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  const res = await request(app, 'POST', '/api/proposals/rej-prop/reject', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const memories = await memory.recall({ farmerId: 'farmer-somchai', query: 'rejected', limit: 5 });
  assert.ok(memories.length >= 1, 'rejection should be recorded as memory');
});
