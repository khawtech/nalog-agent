import { createHash } from 'node:crypto';

/**
 * Extract Firebase UID from a JWT without verifying (NaLog API verifies on use).
 * Falls back to a stable hash of the token for memory partitioning.
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
