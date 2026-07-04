// ──────────────────────────────────────────────────────────────────────────
// Firebase ID token handling.
//
// verifyFirebaseToken() does full cryptographic verification (RS256 signature
// against Google's rotating public certs + iss/aud/exp/iat checks) without
// pulling in the heavyweight firebase-admin SDK — important for a serverless
// ZIP deployment where cold-start size matters.
//
// farmerIdFromToken() is the legacy decode-only helper, still used in dev
// contexts where no FIREBASE_PROJECT_ID is configured.
// ──────────────────────────────────────────────────────────────────────────
import { createHash, createPublicKey, createVerify, X509Certificate } from 'node:crypto';

const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// Cert cache honouring Google's Cache-Control max-age.
let certCache = { certs: null, expiresAt: 0 };

async function fetchGoogleCerts(fetchFn = fetch) {
  if (certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;
  const res = await fetchFn(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error(`failed to fetch Google certs: ${res.status}`);
  const certs = await res.json();
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] || 3600);
  certCache = { certs, expiresAt: Date.now() + maxAge * 1000 };
  return certs;
}

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/**
 * Fully verify a Firebase ID token: signature, issuer, audience, expiry.
 * @param {string} token  Raw or "Bearer "-prefixed JWT.
 * @param {object} [opts]
 * @param {string} opts.projectId  Firebase project id (audience).
 * @param {object} [opts.certs]    Injected {kid: pemCert} map (tests).
 * @returns {Promise<{uid: string, payload: object}>}
 * @throws on any verification failure.
 */
export async function verifyFirebaseToken(token, { projectId, certs } = {}) {
  if (!token) throw new Error('no token');
  if (!projectId) throw new Error('projectId required for verification');
  const clean = token.replace(/^Bearer\s+/i, '');
  const parts = clean.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');

  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

  const certMap = certs || (await fetchGoogleCerts());
  const pem = certMap[header.kid];
  if (!pem) throw new Error('unknown signing key (kid)');

  // Google serves X.509 certs; tests may inject bare public keys.
  const publicKey = /BEGIN CERTIFICATE/.test(pem)
    ? new X509Certificate(pem).publicKey
    : createPublicKey(pem);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  if (!verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'))) {
    throw new Error('invalid signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error('token expired');
  if (payload.iat > now + 300) throw new Error('token issued in the future');
  if (payload.aud !== projectId) throw new Error(`audience mismatch (${payload.aud})`);
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error(`issuer mismatch (${payload.iss})`);
  }
  const uid = payload.user_id || payload.sub;
  if (!uid) throw new Error('token has no uid');
  return { uid, payload };
}

/**
 * Extract Firebase UID from a JWT WITHOUT verifying — only used when no
 * FIREBASE_PROJECT_ID is configured (local dev). Falls back to a stable hash
 * of the token for memory partitioning.
 */
export function farmerIdFromToken(token) {
  if (!token) return null;
  const clean = token.replace(/^Bearer\s+/i, '');
  try {
    const payload = JSON.parse(Buffer.from(clean.split('.')[1], 'base64url').toString('utf8'));
    return payload.user_id || payload.sub || null;
  } catch {
    return `token-${createHash('sha256').update(clean).digest('hex').slice(0, 16)}`;
  }
}

export function resetCertCacheForTests() {
  certCache = { certs: null, expiresAt: 0 };
}
