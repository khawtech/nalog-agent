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
import { DEMO_FARMER } from '../src/integrations/demoData.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-alerts-'));
}

async function setup(agentRun) {
  const dir = tmpDir();
  const store = await new LocalStore(dir).init();
  const memory = new MemoryManager(store, await new LocalVector(dir).init());
  const agent = { run: agentRun };
  return { app: buildApp({ agent, memory, store }) };
}

function request(app, method, url, body = null, headers = {}) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const opts = {
        method,
        hostname: '127.0.0.1',
        port: server.address().port,
        path: url,
        headers: { 'Content-Type': 'application/json', ...headers },
      };
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
      req.on('error', (e) => { server.close(); reject(e); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

test('POST /api/alerts runs an autonomous agent turn and returns proposals', async () => {
  let received = null;
  const { app } = await setup(async (opts) => {
    received = opts;
    return {
      sessionId: opts.sessionId,
      message: 'Level -16cm is below the AWD trigger; proposed pump ON.',
      proposals: [{ proposalId: 'pr1', action: 'on', status: 'pending' }],
      toolTrace: [{ tool: 'get_paddy_status' }],
      memoryUsed: [],
      usage: { turnTokens: 500, totalTokens: 500 },
    };
  });

  const res = await request(app, 'POST', '/api/alerts', {
    paddyId: 'paddy-rice-3',
    sensorId: 'awd-sensor-1',
    metric: 'water_level',
    value: -16.2,
    unit: 'cm',
    threshold: -15,
    direction: 'below',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.proposals.length, 1);
  assert.match(res.body.assessment, /pump ON/);

  // The synthetic turn is scoped to the demo farmer and describes the alert.
  assert.equal(received.farmerId, DEMO_FARMER.farmerId);
  assert.equal(received.sessionId, `alert-${DEMO_FARMER.farmerId}-paddy-rice-3`);
  assert.match(received.userText, /SENSOR ALERT/);
  assert.match(received.userText, /-16\.2cm/);
  assert.match(received.userText, /propose_irrigation/);
});

test('POST /api/alerts requires paddyId', async () => {
  const { app } = await setup(async () => ({}));
  const res = await request(app, 'POST', '/api/alerts', { metric: 'water_level', value: -16 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /paddyId/);
});

test('POST /api/alerts accepts explicit farmerId from a trusted caller', async () => {
  let received = null;
  const { app } = await setup(async (opts) => {
    received = opts;
    return { sessionId: 's', message: 'ok', proposals: [], toolTrace: [], memoryUsed: [], usage: {} };
  });
  const res = await request(app, 'POST', '/api/alerts', {
    paddyId: 'paddy-rice-3',
    farmerId: 'farmer-explicit',
  });
  assert.equal(res.status, 200);
  assert.equal(received.farmerId, 'farmer-explicit');
});
