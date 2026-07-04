// ──────────────────────────────────────────────────────────────────────────
// AgentService — the ReAct loop. Loads memory + farm context, lets Qwen plan
// and call tools, enforces human-in-the-loop for irrigation, persists the turn,
// and autonomously learns durable memory afterwards.
//
// Supports live event streaming (SSE): thinking deltas from the reason tier,
// tool invocations as they happen, and the farmer-facing reply token by token.
// ──────────────────────────────────────────────────────────────────────────
import { nanoid } from 'nanoid';
import config from '../config.js';
import logger from '../logger.js';
import { chat, getUsageTotals, newUsageCollector } from '../llm/dashscope.js';
import { MemoryManager } from '../memory/memoryManager.js';
import { getStore } from '../memory/store/index.js';
import { toolDefinitions, handlers, analyzeFieldPhoto } from './tools.js';
import { buildSystemPrompt, detectReplyLanguage } from './prompts.js';
import * as nalog from '../integrations/nalog.js';
import { buildCropCalendar } from '../integrations/cropCalendar.js';

const MAX_TOOL_ROUNDS = 6;
const HISTORY_WINDOW = 12;

export class AgentService {
  constructor(memory, store, { chatFn = chat } = {}) {
    this.memory = memory;
    this.store = store;
    this.chat = chatFn;
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
   * @param {object} opts
   * @param {string} [opts.imageUrl]  http(s) or data: URL of an attached field
   *                                  photo — analyzed with the Qwen-VL tier.
   * @param {(event: object) => void} [opts.onEvent]  Live progress events:
   *   {type:'session'|'photo'|'thinking'|'tool'|'tool_result'|'proposal'|'delta'}
   * @returns {Promise<{sessionId,message,proposals,toolTrace,memoryUsed,photoAnalysis,usage}>}
   */
  async run({
    sessionId,
    farmerId,
    paddyId = null,
    farmId = null,
    userText,
    imageUrl = null,
    nalogToken = null,
    onEvent = null,
  }) {
    if (!farmerId) throw new Error('farmerId is required');
    if (!userText?.trim() && !imageUrl) throw new Error('userText is required');

    const usage = newUsageCollector();
    const session = await this.getOrCreateSession(sessionId, farmerId);
    if (paddyId) session.paddyId = paddyId;
    if (farmId) session.farmId = farmId;
    const focusPaddy = session.paddyId || paddyId || null;
    const focusFarm = session.farmId || farmId || null;
    onEvent?.({ type: 'session', sessionId: session.sessionId });

    // Multimodal: analyze an attached field photo with Qwen-VL before the
    // reasoning loop, so the (text-only) reason tier can ground on it.
    let photoAnalysis = null;
    let effectiveUserText = userText?.trim() || 'Please look at this photo of my field.';
    if (imageUrl) {
      try {
        photoAnalysis = await analyzeFieldPhoto(
          { imageUrl, question: userText },
          { chatFn: this.chat, usage }
        );
        onEvent?.({ type: 'photo', analysis: photoAnalysis });
        effectiveUserText +=
          `\n\n[Attached field photo — Qwen-VL agronomic analysis]\n${photoAnalysis}`;
      } catch (err) {
        logger.warn({ err: err.message }, 'field photo analysis failed');
        effectiveUserText += '\n\n[A field photo was attached but could not be analyzed.]';
      }
    }

    const profile = await this.memory.getProfile(farmerId);
    const language = profile.preferred_language?.value;
    // Detect from the raw farmer text, not effectiveUserText (photo analysis
    // is appended in English and must not flip the reply language).
    const replyLanguage = detectReplyLanguage(userText);

    const [memoryCtx, farmOverview, history] = await Promise.all([
      this.memory.buildContext({ farmerId, paddyId: focusPaddy, query: effectiveUserText, limit: 5 }),
      this.#farmOverviewSummary(nalogToken),
      this.store.getMessages(session.sessionId, HISTORY_WINDOW),
    ]);

    const systemPrompt = buildSystemPrompt({
      memoryText: memoryCtx.text,
      farmOverview,
      nalogMode: nalog.nalogMode(),
      language,
      activeFarmId: focusFarm,
      replyLanguage,
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: effectiveUserText },
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
      // Seed with the memories injected into the system prompt so they are
      // reinforced when used — not only those the model re-requests via
      // recall_memory.
      recalledMemories: [...memoryCtx.memories],
    };

    const toolTrace = [];
    let finalText = '';
    let reasonDraft = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const assistant = await this.chat({
        tier: 'reason',
        messages,
        tools: toolDefinitions,
        temperature: 0.3,
        maxTokens: config.dashscope.maxTokensPerTurn || undefined,
        usage,
        // Stream the reason tier only to surface thinking deltas; its draft
        // content is discarded when tools ran, so content deltas stay private.
        stream: Boolean(onEvent),
        onDelta: onEvent
          ? (d) => { if (d.reasoning) onEvent({ type: 'thinking', text: d.reasoning }); }
          : undefined,
      });

      messages.push(assistant);

      const toolCalls = assistant.tool_calls || [];
      if (toolCalls.length === 0) {
        if (toolTrace.length > 0) {
          // Tool-based reasoning is done. Let the chat tier (conversation-
          // optimized, cheaper) compose the reply; keep the reason-tier draft
          // as a fallback in case the compose call returns empty.
          reasonDraft = assistant.content || '';
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
        onEvent?.({ type: 'tool', tool: name, args });
        let result;
        try {
          const handler = handlers[name];
          result = handler ? await handler(args, ctx) : { error: `Unknown tool ${name}` };
        } catch (err) {
          logger.warn({ err: err.message, tool: name }, 'tool execution failed');
          result = { error: err.message };
        }
        toolTrace.push({ tool: name, args, result });
        onEvent?.({ type: 'tool_result', tool: name, ok: !result?.error });
        if (name === 'propose_irrigation' && ctx.createdProposals.length > 0) {
          onEvent?.({ type: 'proposal', proposal: ctx.createdProposals.at(-1) });
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    if (!finalText) {
      // After tool rounds, compose the farmer reply with the chat tier. Also
      // serves as safety net when the loop exhausts MAX_TOOL_ROUNDS without a
      // text response. The explicit instruction stops the (tool-less) chat
      // model from narrating further tool plans instead of answering.
      const proposalState =
        ctx.createdProposals.length > 0
          ? `${ctx.createdProposals.length} irrigation proposal(s) WERE created this turn (${ctx.createdProposals
              .map((p) => `pump ${p.action} on ${p.paddyName}`)
              .join('; ')}) — tell the farmer to approve or reject.`
          : 'NO irrigation proposal was created this turn — do NOT claim one was prepared. If a pump action seems needed, ask the farmer if they want you to prepare one.';
      const wrap = await this.chat({
        tier: 'chat',
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              '[SYSTEM] All tool data has been gathered above. Write the final reply to the farmer now, ' +
              (replyLanguage
                ? `ENTIRELY in ${replyLanguage} (the language of the farmer's latest message — ignore the language of earlier messages), `
                : "in the same language as the farmer's latest message, ") +
              'following the style rules. Ground it in the actual numbers from the tool results. ' +
              `Do not mention tools or say you will check anything else. ${proposalState}`,
          },
        ],
        temperature: 0.3,
        usage,
        stream: Boolean(onEvent),
        onDelta: onEvent
          ? (d) => { if (d.content) onEvent({ type: 'delta', text: d.content }); }
          : undefined,
      });
      finalText = wrap.content || reasonDraft || 'ขออภัย ตอนนี้ระบบยังตอบไม่ได้ ลองใหม่อีกครั้งนะครับ';
      if (!wrap.content && reasonDraft) {
        logger.warn('chat-tier compose returned empty — using the reason-tier draft');
        onEvent?.({ type: 'delta', text: reasonDraft });
      }
    } else if (onEvent) {
      // Direct reply from the reason round (no tools) — emit it as one delta.
      onEvent({ type: 'delta', text: finalText });
    }

    // Reinforce the memories the agent actually used this turn (deduplicated:
    // context injection + recall_memory can both surface the same memory).
    const uniqueRecalled = [...new Map(ctx.recalledMemories.map((m) => [m.memoryId, m])).values()];
    await this.memory.reinforce(uniqueRecalled);

    // Periodic cleanup of expired memories and their vector entries.
    this.memory.purgeExpired().catch((err) => logger.warn({ err: err.message }, 'background purge failed'));

    // Persist the turn.
    // Persist the effective text (includes any photo analysis) so follow-up
    // turns can refer back to what the photo showed.
    const now = new Date().toISOString();
    await this.store.appendMessage(session.sessionId, { role: 'user', content: effectiveUserText, ts: now });
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
        transcript: `Farmer: ${effectiveUserText}\nNaLog Agent: ${finalText}`,
      })
      .catch((err) => logger.warn({ err: err.message }, 'background learning failed'));

    return {
      sessionId: session.sessionId,
      message: finalText,
      proposals: ctx.createdProposals,
      toolTrace,
      photoAnalysis,
      memoryUsed: uniqueRecalled.map((m) => ({
        text: m.text,
        when: m.createdAt?.slice(0, 10),
        relevance: +(m.score ?? 0).toFixed(3),
      })),
      usage: {
        turnTokens: usage.total,
        llmCalls: usage.calls,
        totalTokens: getUsageTotals().total,
      },
    };
  }
}
