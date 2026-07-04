import { Router } from 'express';
import config from '../config.js';
import { requireApiKey, authenticateFarmer } from '../middleware/auth.js';
import logger from '../logger.js';

const MAX_IMAGE_CHARS = 6 * 1024 * 1024; // ~4.5MB binary as base64 data URL

function validateImage(image) {
  if (!image) return null;
  if (typeof image !== 'string' || image.length > MAX_IMAGE_CHARS) {
    return 'image must be a data: or http(s) URL under 6MB';
  }
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(image) && !/^https?:\/\//.test(image)) {
    return 'image must be a base64 data URL or an http(s) URL';
  }
  return null;
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default function chatRoutes({ agent, memory, store }) {
  const router = Router();

  // Main conversational endpoint. Set body.stream=true (or Accept:
  // text/event-stream) for live SSE: session → thinking → tool/tool_result →
  // proposal → delta* → final.
  router.post('/api/chat', requireApiKey, authenticateFarmer, async (req, res) => {
    const { sessionId, message, paddyId, farmId, image } = req.body || {};
    const farmerId = req.farmer.farmerId;
    if (req.body?.farmerId && req.body.farmerId !== farmerId) {
      logger.warn(
        { bodyFarmerId: req.body.farmerId, farmerId },
        'farmerId in body ignored — identity comes from the token'
      );
    }

    const hasText = typeof message === 'string' && message.trim();
    if (!hasText && !image) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (hasText && message.length > 4000) {
      return res.status(400).json({ error: 'message too long' });
    }
    const imageError = validateImage(image);
    if (imageError) return res.status(400).json({ error: imageError });

    const wantStream =
      req.body?.stream === true || (req.headers.accept || '').includes('text/event-stream');

    const runOpts = {
      sessionId,
      farmerId,
      paddyId,
      farmId,
      userText: hasText ? message : '',
      imageUrl: image || null,
      nalogToken: req.farmer.token,
    };

    if (!wantStream) {
      try {
        const result = await agent.run(runOpts);
        return res.json(result);
      } catch (err) {
        logger.error({ err: err.message }, 'chat failed');
        return res.status(500).json({ error: 'agent failed to respond' });
      }
    }

    // ── SSE streaming ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    try {
      const result = await agent.run({
        ...runOpts,
        onEvent: (event) => sseWrite(res, event.type, event),
      });
      sseWrite(res, 'final', result);
    } catch (err) {
      logger.error({ err: err.message }, 'chat (stream) failed');
      sseWrite(res, 'error', { error: 'agent failed to respond' });
    }
    res.end();
  });

  // Conversation history for a session (owner only).
  router.get(
    '/api/session/:sessionId/messages',
    requireApiKey,
    authenticateFarmer,
    async (req, res) => {
      const session = await store.getSession(req.params.sessionId);
      if (session && session.farmerId && session.farmerId !== req.farmer.farmerId) {
        return res.status(403).json({ error: 'not your session' });
      }
      const msgs = await store.getMessages(req.params.sessionId, 50);
      res.json({ sessionId: req.params.sessionId, messages: msgs });
    }
  );

  // What the agent currently remembers (for the UI memory panel). The farmer
  // id always comes from the authenticated identity; the ?farmerId override
  // only works in demo mode (used by the local selfcheck).
  router.get('/api/memory', requireApiKey, authenticateFarmer, async (req, res) => {
    const demoOverride = config.nalog.useDemo || !config.nalog.apiUrl;
    const farmerId =
      demoOverride && req.query.farmerId ? req.query.farmerId : req.farmer.farmerId;
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
        reinforcement: m.reinforcement || 0,
      })),
    });
  });

  return router;
}
