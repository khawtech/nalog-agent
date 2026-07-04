import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { verifyFirebaseToken, farmerIdFromToken } from '../src/utils/jwt.js';

const PROJECT = 'nalog-farming';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const certs = { k1: publicPem };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeToken({ kid = 'k1', alg = 'RS256', ...claims } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    user_id: 'farmer-uid-1',
    sub: 'farmer-uid-1',
    iat: now - 60,
    exp: now + 3600,
    ...claims,
  };
  const head = b64url({ alg, typ: 'JWT', kid });
  const body = b64url(payload);
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  const sig = signer.sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

test('verifyFirebaseToken accepts a valid token', async () => {
  const { uid, payload } = await verifyFirebaseToken(makeToken(), { projectId: PROJECT, certs });
  assert.equal(uid, 'farmer-uid-1');
  assert.equal(payload.aud, PROJECT);
});

test('verifyFirebaseToken accepts Bearer prefix', async () => {
  const { uid } = await verifyFirebaseToken(`Bearer ${makeToken()}`, { projectId: PROJECT, certs });
  assert.equal(uid, 'farmer-uid-1');
});

test('verifyFirebaseToken rejects a tampered payload', async () => {
  const token = makeToken();
  const parts = token.split('.');
  parts[1] = b64url({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, user_id: 'attacker', exp: Math.floor(Date.now() / 1000) + 3600, iat: 0 });
  await assert.rejects(
    verifyFirebaseToken(parts.join('.'), { projectId: PROJECT, certs }),
    /invalid signature/
  );
});

test('verifyFirebaseToken rejects expired tokens', async () => {
  const token = makeToken({ exp: Math.floor(Date.now() / 1000) - 10 });
  await assert.rejects(verifyFirebaseToken(token, { projectId: PROJECT, certs }), /expired/);
});

test('verifyFirebaseToken rejects wrong audience', async () => {
  const token = makeToken({ aud: 'other-project' });
  await assert.rejects(verifyFirebaseToken(token, { projectId: PROJECT, certs }), /audience/);
});

test('verifyFirebaseToken rejects wrong issuer', async () => {
  const token = makeToken({ iss: 'https://evil.example.com/nalog-farming' });
  await assert.rejects(verifyFirebaseToken(token, { projectId: PROJECT, certs }), /issuer/);
});

test('verifyFirebaseToken rejects unknown signing key', async () => {
  const token = makeToken({ kid: 'unknown-kid' });
  await assert.rejects(verifyFirebaseToken(token, { projectId: PROJECT, certs }), /unknown signing key/);
});

test('verifyFirebaseToken rejects non-RS256 algorithms (alg confusion)', async () => {
  const head = b64url({ alg: 'none', typ: 'JWT', kid: 'k1' });
  const body = b64url({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, user_id: 'x', exp: Math.floor(Date.now() / 1000) + 3600, iat: 0 });
  await assert.rejects(
    verifyFirebaseToken(`${head}.${body}.`, { projectId: PROJECT, certs }),
    /unexpected alg/
  );
});

test('farmerIdFromToken decodes uid without verification (dev only)', () => {
  assert.equal(farmerIdFromToken(makeToken()), 'farmer-uid-1');
  assert.match(farmerIdFromToken('not-a-jwt'), /^token-[0-9a-f]{16}$/);
  assert.equal(farmerIdFromToken(''), null);
});
