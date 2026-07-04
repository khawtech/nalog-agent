import config from '../config.js';
import logger from '../logger.js';
import { verifyFirebaseToken, farmerIdFromToken } from '../utils/jwt.js';
import { DEMO_FARMER } from '../integrations/demoData.js';

// Shared-secret guard. No-op when AGENT_API_KEY is unset (open local demo).
// When set, requires `x-api-key: <key>` or `Authorization: Bearer <key>`.
export function requireApiKey(req, res, next) {
  if (!config.agentApiKey) return next();
  const header = req.headers['x-api-key'] || '';
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (header === config.agentApiKey || bearer === config.agentApiKey) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

export function extractNalogToken(req) {
  return req.headers['x-nalog-token'] || '';
}

/**
 * Resolve the farmer identity for a request and attach it as req.farmer =
 * { farmerId, verified, token }.
 *
 * Policy:
 *  - Token + FIREBASE_PROJECT_ID  → cryptographically verified; bad token → 401.
 *  - Token, no project configured → decode-only fallback (local dev), warned once.
 *  - No token, demo mode          → bundled demo farmer.
 *  - No token, live mode          → 401 (identity is required to touch real
 *                                   farmer memory or real pumps).
 */
export async function authenticateFarmer(req, res, next) {
  const token = extractNalogToken(req);

  if (token) {
    if (config.firebase.projectId) {
      try {
        const { uid } = await verifyFirebaseToken(token, { projectId: config.firebase.projectId });
        req.farmer = { farmerId: uid, verified: true, token };
        return next();
      } catch (err) {
        logger.warn({ err: err.message }, 'X-NaLog-Token verification failed');
        return res.status(401).json({ error: 'invalid farmer token' });
      }
    }
    // Dev fallback: no project configured → trust the decoded uid, flag it.
    req.farmer = { farmerId: farmerIdFromToken(token), verified: false, token };
    return next();
  }

  if (config.nalog.useDemo || !config.nalog.apiUrl) {
    req.farmer = { farmerId: DEMO_FARMER.farmerId, verified: false, token: null };
    return next();
  }

  return res.status(401).json({ error: 'farmer identity required (X-NaLog-Token)' });
}
