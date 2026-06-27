import config from '../config.js';

// Optional shared-secret guard. No-op when AGENT_API_KEY is unset (open demo).
// When set, requires `x-api-key: <key>` or `Authorization: Bearer <key>`.
export function requireApiKey(req, res, next) {
  if (!config.agentApiKey) return next();
  const header = req.headers['x-api-key'] || '';
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (header === config.agentApiKey || bearer === config.agentApiKey) return next();
  return res.status(401).json({ error: 'unauthorized' });
}
