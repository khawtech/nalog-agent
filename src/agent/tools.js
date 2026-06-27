// ──────────────────────────────────────────────────────────────────────────
// Tool definitions (OpenAI function-calling schema) and their handlers.
// Handlers receive (args, ctx) where ctx = { farmerId, sessionId, paddyId,
// memory, store, createdProposals }.
// ──────────────────────────────────────────────────────────────────────────
import { nanoid } from 'nanoid';
import * as nalog from '../integrations/nalog.js';
import { buildCropCalendar } from '../integrations/cropCalendar.js';
import logger from '../logger.js';

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'get_farm_overview',
      description:
        "List the farmer's farms and paddies with crop type and growth stage. Use this to find the correct paddyId.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_paddy_status',
      description:
        'Get the current real state of a paddy: crop, growth stage, cropCalendar (plantingDate, day X of Y, days until sugar formation), AWD cycle/phase, sensors, latest readings and trend.',
      parameters: {
        type: 'object',
        properties: { paddyId: { type: 'string', description: 'The paddy id, e.g. paddy-rice-3' } },
        required: ['paddyId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sensor_history',
      description: 'Get recent sensor readings (summarised) for a sensor over the last N hours.',
      parameters: {
        type: 'object',
        properties: {
          sensorId: { type: 'string' },
          hours: { type: 'number', description: 'Lookback window in hours (default 72)' },
        },
        required: ['sensorId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description:
        'Recall the most relevant past experience and preferences for this farmer (optionally scoped to a paddy).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to remember about, in a few words' },
          paddyId: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        'Save a durable piece of field experience worth remembering next season (an outcome, observation, decision).',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['observation', 'preference', 'outcome', 'decision'] },
          text: { type: 'string', description: 'Concise fact in English' },
          paddyId: { type: 'string' },
          structured: { type: 'object', description: 'Optional structured data', additionalProperties: true },
        },
        required: ['type', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_profile',
      description:
        "Update a durable fact about the farmer (e.g. preferred_language, irrigation_style, channel).",
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: {},
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_irrigation_history',
      description:
        'Get pump controls and irrigation events for a farm or paddy — use to answer when paddies were last watered/irrigated. Always check lastWatering and lastWateringByPaddy even if events in the hours window is empty.',
      parameters: {
        type: 'object',
        properties: {
          farmId: { type: 'string', description: 'Farm id from FARMS list (e.g. osVuZ2DjHwtc) — never the farm display name' },
          paddyId: { type: 'string', description: 'Optional — scope to one paddy' },
          hours: { type: 'number', description: 'Lookback window for recent events list (default 720 = 30 days). lastWatering is always the most recent ever returned.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_irrigation',
      description:
        'Prepare a pump action for the farmer to APPROVE (human-in-the-loop). Use for turning a pump on/off. Never executes by itself.',
      parameters: {
        type: 'object',
        properties: {
          paddyId: { type: 'string' },
          action: { type: 'string', enum: ['on', 'off'] },
          reason: { type: 'string', description: 'Short reason shown to the farmer' },
        },
        required: ['paddyId', 'action', 'reason'],
      },
    },
  },
];

export const handlers = {
  async get_farm_overview(_args, ctx) {
    const token = ctx.nalogToken;
    const farms = await nalog.getFarms(token);
    const out = [];
    for (const farm of farms) {
      const paddies = await nalog.getPaddies(farm.farmId, token).catch(() => []);
      out.push({
        farmId: farm.farmId,
        name: farm.name,
        location: farm.description || farm.location,
        paddies: paddies.map((p) => {
          const cal = buildCropCalendar(p);
          return {
            paddyId: p.paddyId,
            name: p.name,
            cropType: p.cropType,
            growthStage: p.growthStage,
            plantingDate: p.plantingDate || null,
            ...(cal && {
              daysInCurrentStage: cal.daysInCurrentStage,
              stageDurationDays: cal.stageDurationDays,
              daysRemainingInStage: cal.daysRemainingInStage,
            }),
          };
        }),
      });
    }
    return { farms: out };
  },

  async get_paddy_status({ paddyId }, ctx) {
    const status = await nalog.getPaddyStatus(paddyId, ctx.nalogToken);
    if (!status) return { error: `Paddy ${paddyId} not found` };
    return status;
  },

  async get_sensor_history({ sensorId, hours = 72 }, ctx) {
    const hist = await nalog.getSensorHistory(sensorId, hours, ctx.nalogToken);
    if (!hist.length) return { sensorId, points: 0 };
    const values = hist
      .map((d) => d.payload?.level ?? d.payload?.moisture ?? d.payload?.value)
      .filter((v) => v != null);
    const latest = hist[hist.length - 1];
    return {
      sensorId,
      hours,
      points: hist.length,
      latest: latest.payload,
      latestAt: latest.timestamp,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      first: values[0] ?? null,
      last: values[values.length - 1] ?? null,
    };
  },

  async get_irrigation_history({ farmId, paddyId, hours = 720 }, ctx) {
    // Page/session farmId wins — the model often passes the farm display name as farmId.
    let fid = ctx.farmId || farmId;
    if (!fid && paddyId) {
      const paddy = await nalog.getPaddy(paddyId, ctx.nalogToken).catch(() => null);
      fid = paddy?.farmId;
    }
    if (!fid && ctx.paddyId) {
      const paddy = await nalog.getPaddy(ctx.paddyId, ctx.nalogToken).catch(() => null);
      fid = paddy?.farmId;
      paddyId = paddyId || ctx.paddyId;
    }
    if (!fid) return { error: 'farmId or paddyId required' };
    fid = await nalog.resolveFarmId(fid, ctx.nalogToken);
    return nalog.getIrrigationHistory(
      { farmId: fid, paddyId: paddyId || null, hours },
      ctx.nalogToken
    );
  },

  async recall_memory({ query, paddyId }, ctx) {
    const memories = await ctx.memory.recall({
      farmerId: ctx.farmerId,
      paddyId: paddyId || ctx.paddyId || null,
      query,
      limit: 5,
    });
    ctx.recalledMemories.push(...memories);
    return {
      memories: memories.map((m) => ({
        when: m.createdAt?.slice(0, 10),
        season: m.season,
        paddyId: m.paddyId,
        type: m.type,
        text: m.text,
        relevance: +m.score.toFixed(3),
      })),
    };
  },

  async save_memory({ type, text, paddyId, structured }, ctx) {
    const mem = await ctx.memory.recordEpisodic({
      farmerId: ctx.farmerId,
      paddyId: paddyId || ctx.paddyId || null,
      type,
      text,
      structured: structured || {},
    });
    return { saved: true, memoryId: mem.memoryId };
  },

  async update_profile({ key, value, confidence }, ctx) {
    await ctx.memory.setProfileFact(ctx.farmerId, key, value, confidence ?? 0.8);
    return { updated: true, key };
  },

  async propose_irrigation({ paddyId, action, reason }, ctx) {
    const status = await nalog.getPaddyStatus(paddyId, ctx.nalogToken).catch(() => null);
    const devEUI =
      status?.paddy?.riceConfig?.pumpDevEUI ||
      status?.sensors?.find((s) => s.type === 'awd')?.devEUI ||
      null;

    const proposal = {
      proposalId: nanoid(10),
      sessionId: ctx.sessionId,
      farmerId: ctx.farmerId,
      paddyId,
      paddyName: status?.paddy?.name || paddyId,
      action,
      reason,
      devEUI,
      status: 'pending',
      createdAt: new Date().toISOString(),
      context: {
        growthStage: status?.paddy?.growthStage,
        latest: status?.sensors?.find((s) => s.type === 'awd')?.latest,
        awdPhase: status?.awdCycle?.currentPhase,
      },
    };
    await ctx.store.putProposal(proposal);
    ctx.createdProposals.push(proposal);
    logger.info({ proposalId: proposal.proposalId, paddyId, action }, 'irrigation proposal created');
    return {
      proposalId: proposal.proposalId,
      status: 'pending_approval',
      message: 'Proposal created and is awaiting the farmer\'s approval.',
      devEUIKnown: Boolean(devEUI),
    };
  },
};
