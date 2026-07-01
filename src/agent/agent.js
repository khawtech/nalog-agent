// ──────────────────────────────────────────────────────────────────────────
// AgentService — the ReAct loop. Loads memory + farm context, lets Qwen plan
// and call tools, enforces human-in-the-loop for irrigation, persists the turn,
// and autonomously learns durable memory afterwards.
// ──────────────────────────────────────────────────────────────────────────
import { nanoid } from 'nanoid';
import config from '../config.js';
import logger from '../logger.js';
import { chat, getUsageTotals } from '../llm/dashscope.js';
import { MemoryManager } from '../memory/memoryManager.js';
import { getStore } from '../memory/store/index.js';
import { toolDefinitions, handlers } from './tools.js';
import { buildSystemPrompt } from './prompts.js';
import * as nalog from '../integrations/nalog.js';
import { buildCropCalendar } from '../integrations/cropCalendar.js';

const MAX_TOOL_ROUNDS = 6;
const HISTORY_WINDOW = 12;

export class AgentService {
  constructor(memory, store) {
    this.memory = memory;
    this.store = store;
  }

  static async create() {
    return new AgentService(await MemoryManager.create(), await getStore());
  }

  async getOrCreateSession(sessionId, farmerId) {
    let session = sessionId ? await this.store.getSession(sessionId) : null;
    if (!session) {
      session = {
        sessionId: sessionId || `sess-${nanoid(10)}`,
        farmerId,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        paddyId: null,
      };
      await this.store.saveSession(session);
    }
    return session;
  }

  async #farmOverviewSummary(nalogToken) {
    try {
      const farms = await nalog.getFarms(nalogToken);
      const lines = [];
      for (const farm of farms) {
        const paddies = await nalog.getPaddies(farm.farmId, nalogToken).catch(() => []);
        lines.push(`Farm "${farm.name}":`);
        for (const p of paddies) {
          const cal = buildCropCalendar(p);
          const stageLine = cal?.daysInCurrentStage != null
            ? `, day ${cal.daysInCurrentStage} of ${cal.stageDurationDays}`
            : '';
          const planted = p.plantingDate ? `, planted ${p.plantingDate.slice(0, 10)}` : '';
          lines.push(
            `  - ${p.paddyId} — ${p.name} (${p.cropType}, stage: ${p.growthStage}${stageLine}${planted})`
          );
        }
      }
      return `FARMS & PADDIES AVAILABLE:\n${lines.join('\n')}`;
    } catch (err) {
      logger.warn({ err: err.message }, 'farm overview unavailable');
      return 'FARMS & PADDIES: (unavailable right now)';
    }
  }

  /**
   * Run one conversational turn.
   * @returns {Promise<{sessionId,message,proposals,toolTrace,memoryUsed,usage}>}
   */
  async run({ sessionId, farmerId, paddyId = null, farmId = null, userText, nalogToken = null }) {
    if (!farmerId) throw new Error('farmerId is required');
    if (!userText?.trim()) throw new Error('userText is required');

    const session = await this.getOrCreateSession(sessionId, farmerId);
    if (paddyId) session.paddyId = paddyId;
    if (farmId) session.farmId = farmId;
    const focusPaddy = session.paddyId || paddyId || null;
    const focusFarm = session.farmId || farmId || null;

    const profile = await this.memory.getProfile(farmerId);
    const language = profile.preferred_language?.value;

    const [memoryCtx, farmOverview, history] = await Promise.all([
      this.memory.buildContext({ farmerId, paddyId: focusPaddy, query: userText, limit: 5 }),
      this.#farmOverviewSummary(nalogToken),
      this.store.getMessages(session.sessionId, HISTORY_WINDOW),
    ]);

    const systemPrompt = buildSystemPrompt({
      memoryText: memoryCtx.text,
      farmOverview,
      nalogMode: nalog.nalogMode(),
      language,
      activeFarmId: focusFarm,
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userText },
    ];

    const ctx = {
      farmerId,
      sessionId: session.sessionId,
      paddyId: focusPaddy,
      farmId: focusFarm,
      nalogToken,
      memory: this.memory,
      store: this.store,
      createdProposals: [],
      recalledMemories: [],
    };

    const toolTrace = [];
    const usageBefore = getUsageTotals();
    let finalText = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const assistant = await chat({
        tier: 'reason',
        messages,
        tools: toolDefinitions,
        temperature: 0.3,
        maxTokens: config.dashscope.maxTokensPerTurn || undefined,
      });

      messages.push(assistant);

      const toolCalls = assistant.tool_calls || [];
      if (toolCalls.length === 0) {
        if (toolTrace.length > 0) {
          // Tool-based reasoning is done. Discard the qwen-max draft and let
          // qwen-plus (conversation-optimized, cheaper) compose the farmer reply.
          messages.pop();
        } else {
          finalText = assistant.content || '';
        }
        break;
      }

      // Execute the requested tools and feed results back for the next round.
      for (const call of toolCalls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        let result;
        try {
          const handler = handlers[name];
          result = handler ? await handler(args, ctx) : { error: `Unknown tool ${name}` };
        } catch (err) {
          logger.warn({ err: err.message, tool: name }, 'tool execution failed');
          result = { error: err.message };
        }
        toolTrace.push({ tool: name, args, result });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    if (!finalText) {
      // After tool rounds, compose the farmer reply with qwen-plus (conversation-
      // optimized, cheaper). Also serves as safety net when the loop exhausts
      // MAX_TOOL_ROUNDS without a text response.
      const wrap = await chat({ tier: 'chat', messages, temperature: 0.3 });
      finalText = wrap.content || 'ขออภัย ตอนนี้ระบบยังตอบไม่ได้ ลองใหม่อีกครั้งนะครับ';
    }

    // Reinforce memories the agent actually recalled this turn.
    await this.memory.reinforce(ctx.recalledMemories);

    // Periodic cleanup of expired memories and their vector entries.
    this.memory.purgeExpired().catch((err) => logger.warn({ err: err.message }, 'background purge failed'));

    // Persist the turn.
    const now = new Date().toISOString();
    await this.store.appendMessage(session.sessionId, { role: 'user', content: userText, ts: now });
    await this.store.appendMessage(session.sessionId, {
      role: 'assistant',
      content: finalText,
      ts: new Date().toISOString(),
    });
    session.lastActiveAt = now;
    await this.store.saveSession(session);

    // Autonomous memory accumulation (cheap model).
    this.memory
      .learnFromConversation({
        farmerId,
        paddyId: focusPaddy,
        transcript: `Farmer: ${userText}\nNaLog Agent: ${finalText}`,
      })
      .catch((err) => logger.warn({ err: err.message }, 'background learning failed'));

    const usageAfter = getUsageTotals();
    return {
      sessionId: session.sessionId,
      message: finalText,
      proposals: ctx.createdProposals,
      toolTrace,
      memoryUsed: ctx.recalledMemories.map((m) => ({
        text: m.text,
        when: m.createdAt?.slice(0, 10),
        relevance: +m.score.toFixed(3),
      })),
      usage: {
        turnTokens: usageAfter.total - usageBefore.total,
        totalTokens: usageAfter.total,
      },
    };
  }
}
