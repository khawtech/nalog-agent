import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { requireApiKey, authenticateFarmer } from '../src/middleware/auth.js';
import { DEMO_FARMER } from '../src/integrations/demoData.js';

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const run = (mw, req) =>
  new Promise((resolve) => {
    const res = mockRes();
    Promise.resolve(mw(req, res, () => resolve({ next: true, req, res }))).then(
      () => setImmediate(() => resolve({ next: false, req, res }))
    );
  });

const originalKey = config.agentApiKey;
const originalDemo = config.nalog.useDemo;
const originalApiUrl = config.nalog.apiUrl;

afterEach(() => {
  config.agentApiKey = originalKey;
  config.nalog.useDemo = originalDemo;
  config.nalog.apiUrl = originalApiUrl;
});

test('requireApiKey passes everything through when no key configured', async () => {
  config.agentApiKey = '';
  const { next } = await run(requireApiKey, { headers: {} });
  assert.equal(next, true);
});

test('requireApiKey rejects wrong/missing key with 401', async () => {
  config.agentApiKey = 'secret-key';
  const missing = await run(requireApiKey, { headers: {} });
  assert.equal(missing.next, false);
  assert.equal(missing.res.statusCode, 401);

  const wrong = await run(requireApiKey, { headers: { 'x-api-key': 'nope' } });
  assert.equal(wrong.res.statusCode, 401);
});

test('requireApiKey accepts x-api-key and Bearer forms', async () => {
  config.agentApiKey = 'secret-key';
  const viaHeader = await run(requireApiKey, { headers: { 'x-api-key': 'secret-key' } });
  assert.equal(viaHeader.next, true);
  const viaBearer = await run(requireApiKey, { headers: { authorization: 'Bearer secret-key' } });
  assert.equal(viaBearer.next, true);
});

test('authenticateFarmer falls back to the demo farmer in demo mode', async () => {
  config.nalog.useDemo = true;
  const { next, req } = await run(authenticateFarmer, { headers: {} });
  assert.equal(next, true);
  assert.equal(req.farmer.farmerId, DEMO_FARMER.farmerId);
  assert.equal(req.farmer.verified, false);
});

test('authenticateFarmer requires identity in live mode', async () => {
  config.nalog.useDemo = false;
  config.nalog.apiUrl = 'https://nalog.example.com';
  const { next, res } = await run(authenticateFarmer, { headers: {} });
  assert.equal(next, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /identity/i);
});

test('authenticateFarmer decodes token uid when no Firebase project configured', async () => {
  // config.firebase.projectId is '' in tests (FIREBASE_PROJECT_ID= in npm test)
  const payload = Buffer.from(JSON.stringify({ user_id: 'uid-decoded' })).toString('base64url');
  const token = `x.${payload}.y`;
  const { next, req } = await run(authenticateFarmer, { headers: { 'x-nalog-token': token } });
  assert.equal(next, true);
  assert.equal(req.farmer.farmerId, 'uid-decoded');
  assert.equal(req.farmer.verified, false);
});
