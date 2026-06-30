// Mint a Firebase ID token for integration smoke tests.
// Set FIREBASE_SERVICE_ACCOUNT_PATH and FIREBASE_WEB_API_KEY (see .env.example).
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localDir = process.env.FIREBASE_LOCAL_DIR || join(__dirname, '..', 'local');

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

  const require = createRequire(join(__dirname, '..', 'package.json'));
  const admin = require('firebase-admin');

  const serviceAccount = JSON.parse(readFileSync(saPath, 'utf8'));
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }

  const customToken = await admin.auth().createCustomToken(uid);
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
