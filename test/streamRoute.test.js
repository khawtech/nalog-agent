import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/server.js';
import LocalStore from '../src/memory/store/localStore.js';
import LocalVector from '../src/memory/vector/localVector.js';
import { MemoryManager } from '../src/memory/memoryManager.js';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-sse-'));
  const store = await new LocalStore(dir).init();
  const memory = new MemoryManager(store, await new LocalVector(dir).init());
  const agent = {
    async run({ onEvent }) {
      onEvent?.({ type: 'session', sessionId: 's-1' });
      onEvent?.({ type: 'tool', tool: 'get_paddy_status', args: { paddyId: 'p3' } });
      onEvent?.({ type: 'tool_result', tool: 'get_paddy_status', ok: true });
      onEvent?.({ type: 'delta', text: 'Water level ' });
      onEvent?.({ type: 'delta', text: 'is -12cm.' });
      return {
        sessionId: 's-1',
        message: 'Water level is -12cm.',
        proposals: [],
        toolTrace: [{ tool: 'get_paddy_status' }],
        memoryUsed: [],
        usage: { turnTokens: 100, totalTokens: 100 },
      };
    },
  };
  return buildApp({ agent, memory, store });
}

function sseRequest(app, body) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const req = http.request(
        {
          method: 'POST',
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/api/chat',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, contentType: res.headers['content-type'], raw });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function parseSSE(raw) {
  return raw
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /event: (.+)/.exec(block)?.[1];
      const data = /data: (.+)/.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

test('POST /api/chat with Accept: text/event-stream returns live SSE events', async () => {
  const app = await setup();
  const res = await sseRequest(app, { message: 'สถานะนา 3?' });

  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/event-stream/);

  const events = parseSSE(res.raw);
  const types = events.map((e) => e.event);
  assert.deepEqual(types, ['session', 'tool', 'tool_result', 'delta', 'delta', 'final']);

  const final = events.at(-1).data;
  assert.equal(final.message, 'Water level is -12cm.');
  assert.equal(final.toolTrace.length, 1);

  const streamedText = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.equal(streamedText, final.message, 'deltas must reassemble into the final message');
});

test('POST /api/chat validates image payloads', async () => {
  const app = await setup();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'look', image: 'ftp://not-allowed' }),
  });
  server.close();
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /image/i);
});
