import { Router } from 'express';
import config from '../config.js';
import logger from '../logger.js';
import { sendPumpCommand } from '../integrations/chirpstack.js';
import { requireApiKey } from '../middleware/auth.js';

export default function proposalRoutes({ store, memory }) {
  const router = Router();

  router.get('/api/proposals', requireApiKey, async (req, res) => {
    const { sessionId, status } = req.query;
    const proposals = await store.listProposals({ sessionId, status });
    res.json({ proposals });
  });

  router.get('/api/proposals/:id', requireApiKey, async (req, res) => {
    const proposal = await store.getProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'proposal not found' });
    res.json(proposal);
  });

  // Human-in-the-loop APPROVE → enqueue the LoRa downlink to the pump.
  router.post('/api/proposals/:id/approve', requireApiKey, async (req, res) => {
    const proposal = await store.getProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'proposal not found' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `proposal already ${proposal.status}` });
    }
    try {
      let downlink = { simulated: true, sent: false };
      if (proposal.devEUI) {
        downlink = await sendPumpCommand(proposal.devEUI, proposal.action);
      } else {
        logger.warn({ proposalId: proposal.proposalId }, 'no devEUI on proposal — cannot send downlink');
      }
      const updated = await store.updateProposal(proposal.proposalId, {
        status: 'executed',
        approvedBy: req.body?.approvedBy || 'farmer',
        decidedAt: new Date().toISOString(),
        downlink,
      });

      // Record the decision as durable memory so the agent learns the pattern.
      await memory.recordEpisodic({
        farmerId: proposal.farmerId,
        paddyId: proposal.paddyId,
        type: 'decision',
        text: `Farmer approved pump ${proposal.action} on ${proposal.paddyName}. Reason: ${proposal.reason}`,
        structured: { action: proposal.action, approved: true, devEUI: proposal.devEUI },
      });

      res.json({ ok: true, proposal: updated, downlink, requireHumanApproval: config.requireHumanApproval });
    } catch (err) {
      logger.error({ err: err.message }, 'approve failed');
      res.status(500).json({ error: 'failed to send irrigation command' });
    }
  });

  router.post('/api/proposals/:id/reject', requireApiKey, async (req, res) => {
    const proposal = await store.getProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'proposal not found' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `proposal already ${proposal.status}` });
    }
    try {
      const updated = await store.updateProposal(proposal.proposalId, {
        status: 'rejected',
        decidedAt: new Date().toISOString(),
      });
      // Learn from the rejection too.
      await memory.recordEpisodic({
        farmerId: proposal.farmerId,
        paddyId: proposal.paddyId,
        type: 'preference',
        text: `Farmer rejected pump ${proposal.action} on ${proposal.paddyName} (reason offered: ${proposal.reason}).`,
        structured: { action: proposal.action, approved: false },
      });
      res.json({ ok: true, proposal: updated });
    } catch (err) {
      logger.error({ err: err.message }, 'reject failed');
      res.status(500).json({ error: 'failed to reject proposal' });
    }
  });

  return router;
}
