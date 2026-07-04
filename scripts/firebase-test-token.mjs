// Mint a Firebase ID token for integration smoke tests — no firebase-admin SDK.
// Signs a custom token with the service-account private key (node:crypto RS256)
// and exchanges it via the Identity Toolkit REST API.
//
// Inputs (first match wins):
//   NALOG_TEST_TOKEN                  — use a ready-made ID token as-is
//   FIREBASE_SERVICE_ACCOUNT_PATH     — service-account JSON (default local/firebase-service-account.json)
//   FIREBASE_WEB_API_KEY              — the web app's public API key
import { readFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localDir = process.env.FIREBASE_LOCAL_DIR || join(__dirname, '..', 'local');

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function signCustomToken(serviceAccount, uid) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
  };
  const unsigned = `${b64url(header)}.${b64url(payload)}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(serviceAccount.private_key)
    .toString('base64url');
  return `${unsigned}.${signature}`;
}

export async function getTestFirebaseToken(uid) {
  if (process.env.NALOG_TEST_TOKEN) return process.env.NALOG_TEST_TOKEN;

  const saPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    join(localDir, 'firebase-service-account.json');
  if (!existsSync(saPath)) return null;

  const apiKey =
    process.env.FIREBASE_WEB_API_KEY ||
    process.env.VITE_FIREBASE_API_KEY ||
    '';
  if (!apiKey) throw new Error('FIREBASE_WEB_API_KEY or VITE_FIREBASE_API_KEY env var is required');

  const serviceAccount = JSON.parse(readFileSync(saPath, 'utf8'));
  const customToken = signCustomToken(serviceAccount, uid);

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Firebase signInWithCustomToken failed');
  return json.idToken;
}

// Direct invocation: print a fresh token, and a ready-to-open demo URL when
// BASE_URL is set.  Usage:
//   node scripts/firebase-test-token.mjs <uid> [BASE_URL=https://... AGENT_API_KEY=...]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
  const uid = process.argv[2] || process.env.DEMO_FARMER_ID || 'demo-farmer';
  const token = await getTestFirebaseToken(uid);
  if (!token) {
    console.error('No service account found — set FIREBASE_SERVICE_ACCOUNT_PATH or NALOG_TEST_TOKEN.');
    process.exit(1);
  }
  console.log(token);
  if (process.env.BASE_URL) {
    const u = new URL(process.env.BASE_URL);
    if (process.env.AGENT_API_KEY) u.searchParams.set('key', process.env.AGENT_API_KEY);
    u.searchParams.set('token', token);
    console.error(`\nDemo URL (valid ~1h):\n${u}`);
  }
}
