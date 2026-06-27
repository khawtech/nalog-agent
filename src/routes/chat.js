import { Router } from 'express';
import { DEMO_FARMER } from '../integrations/demoData.js';
import { requireApiKey } from '../middleware/auth.js';
import { farmerIdFromToken } from '../utils/jwt.js';
import logger from '../logger.js';

function extractNalogToken(req) {
  return (
    req.headers['x-nalog-token'] ||
    req.headers['X-NaLog-Token'] ||
    ''
  );
}

export default function chatRoutes({ agent, memory, store }) {
  const router = Router();

  // Main conversational endpoint.
  router.post('/api/chat', requireApiKey, async (req, res) => {
    const { sessionId, message, paddyId, farmId } = req.body || {};
    const nalogToken = extractNalogToken(req);
    const farmerId =
      req.body?.farmerId ||
      farmerIdFromToken(nalogToken) ||
      DEMO_FARMER.farmerId;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: 'message too long' });
    }
    try {
      const result = await agent.run({
        sessionId,
        farmerId,
        paddyId,
        farmId,
        userText: message,
        nalogToken: nalogToken || null,
      });
      res.json(result);
    } catch (err) {
      logger.error({ err: err.message }, 'chat failed');
      res.status(500).json({ error: 'agent failed to respond' });
    }
  });

  // Conversation history for a session.
  router.get('/api/session/:sessionId/messages', requireApiKey, async (req, res) => {
    const msgs = await store.getMessages(req.params.sessionId, 50);
    res.json({ sessionId: req.params.sessionId, messages: msgs });
  });

  // What the agent currently remembers (for the UI memory panel).
  router.get('/api/memory', requireApiKey, async (req, res) => {
    const farmerId = req.query.farmerId || DEMO_FARMER.farmerId;
    const paddyId = req.query.paddyId || null;
    const [profile, memories] = await Promise.all([
      memory.getProfile(farmerId),
      memory.recall({ farmerId, paddyId, query: '', limit: 8 }),
    ]);
    res.json({
      farmerId,
      profile: Object.fromEntries(
        Object.entries(profile).map(([k, v]) => [k, v.value])
      ),
      memories: memories.map((m) => ({
        when: m.createdAt?.slice(0, 10),
        season: m.season,
        paddyId: m.paddyId,
        type: m.type,
        text: m.text,
      })),
    });
  });

  return router;
}
