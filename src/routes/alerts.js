// ──────────────────────────────────────────────────────────────────────────
// Sensor alert webhook — the autonomous entry point (Track 4).
//
// The NaLog platform (or any monitoring rule) POSTs here when a sensor
// crosses a threshold. The agent runs a full reasoning turn WITHOUT a farmer
// message: it reads the live paddy state, recalls this farmer's history, and
// — if action is warranted — creates an irrigation proposal that still
// requires human approval before any LoRaWAN downlink. Machine-to-machine:
// authenticated with AGENT_API_KEY; farmer scoping via X-NaLog-Token when
// present, else the trusted farmerId in the payload.
// ──────────────────────────────────────────────────────────────────────────
import { Router } from 'express';
import config from '../config.js';
import logger from '../logger.js';
import { requireApiKey, extractNalogToken } from '../middleware/auth.js';
import { verifyFirebaseToken, farmerIdFromToken } from '../utils/jwt.js';
import { DEMO_FARMER } from '../integrations/demoData.js';

function alertText({ paddyId, sensorId, metric, value, unit, threshold, direction, note }) {
  const parts = [
    `[SENSOR ALERT] Paddy ${paddyId}`,
    metric != null && value != null
      ? `${metric} = ${value}${unit || ''}` +
        (threshold != null ? ` crossed the ${direction || 'alert'} threshold ${threshold}${unit || ''}` : '')
      : null,
    sensorId ? `(sensor ${sensorId})` : null,
    note ? `Note: ${note}` : null,
  ].filter(Boolean);
  return (
    `${parts.join(' ')}. ` +
    'Verify against the live paddy status and this farmer\'s history, explain what is happening, ' +
    'and if a pump action is warranted call propose_irrigation (the farmer will approve or reject it). ' +
    'If no action is needed, say why.'
  );
}

export default function alertRoutes({ agent }) {
  const router = Router();

  router.post('/api/alerts', requireApiKey, async (req, res) => {
    const { paddyId, sensorId, metric, value, unit, threshold, direction, note } = req.body || {};
    if (!paddyId || typeof paddyId !== 'string') {
      return res.status(400).json({ error: 'paddyId is required' });
    }

    // Farmer scoping: verified token when provided; otherwise the payload's
    // farmerId (trusted M2M caller holding the API key); demo farmer locally.
    const token = extractNalogToken(req);
    let farmerId = null;
    if (token) {
      if (config.firebase.projectId) {
        try {
          farmerId = (await verifyFirebaseToken(token, { projectId: config.firebase.projectId })).uid;
        } catch (err) {
          return res.status(401).json({ error: `invalid farmer token: ${err.message}` });
        }
      } else {
        farmerId = farmerIdFromToken(token);
      }
    } else if (req.body?.farmerId) {
      farmerId = String(req.body.farmerId);
    } else if (config.nalog.useDemo || !config.nalog.apiUrl) {
      farmerId = DEMO_FARMER.farmerId;
    }
    if (!farmerId) {
      return res.status(400).json({ error: 'farmerId (or X-NaLog-Token) is required' });
    }

    try {
      const result = await agent.run({
        // Alert turns share one session per paddy so repeated alerts keep context.
        sessionId: `alert-${farmerId}-${paddyId}`,
        farmerId,
        paddyId,
        userText: alertText({ paddyId, sensorId, metric, value, unit, threshold, direction, note }),
        nalogToken: token || null,
      });
      logger.info(
        { paddyId, farmerId, proposals: result.proposals.length },
        'sensor alert processed by agent'
      );
      res.json({
        ok: true,
        alert: { paddyId, sensorId, metric, value },
        assessment: result.message,
        proposals: result.proposals,
        toolTrace: result.toolTrace,
        usage: result.usage,
        sessionId: result.sessionId,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'alert processing failed');
      res.status(500).json({ error: 'agent failed to process alert' });
    }
  });

  return router;
}
