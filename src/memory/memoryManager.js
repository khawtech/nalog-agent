// ──────────────────────────────────────────────────────────────────────────
// MemoryManager — the brain's memory system. Three tiers:
//
//   1. Profile memory (sticky)    — durable facts about a farmer
//                                    (language, channel, crop, risk tolerance…)
//   2. Episodic memory (decaying) — dated field experience tied to a paddy
//                                    ("Paddy 3 drained +5→-15cm in 4.2 days")
//   3. Semantic recall (vectors)  — retrieve the few most relevant memories
//                                    for the current situation, then summarize.
//
// Forgetting is both soft (relevance decays with age, reinforced by reuse) and
// hard (Tablestore TTL physically drops memories after ~2 seasons).
// Recall is deliberately top-K + summarized so it fits a small context window
// — exactly the constraint of offline-first rural deployments.
// ──────────────────────────────────────────────────────────────────────────
import { nanoid } from 'nanoid';
import { getStore } from './store/index.js';
import { getVectorStore } from './vector/index.js';
import { embedOne } from '../llm/embeddings.js';
import { chatJSON } from '../llm/dashscope.js';
import logger from '../logger.js';

const RECENCY_HALF_LIFE_DAYS = 120; // ~one season
const WEIGHTS = { semantic: 0.6, recency: 0.25, reinforcement: 0.15 };

export function currentSeason(date = new Date()) {
  const m = date.getUTCMonth() + 1; // Thailand: wet ≈ May–Oct, dry ≈ Nov–Apr
  const phase = m >= 5 && m <= 10 ? 'wet' : 'dry';
  const year = phase === 'dry' && m <= 4 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
  return `${year}-${phase}`;
}

function recencyFactor(createdAt) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  return Math.exp((-Math.LN2 * Math.max(ageDays, 0)) / RECENCY_HALF_LIFE_DAYS);
}

export class MemoryManager {
  constructor(store, vector) {
    this.store = store;
    this.vector = vector;
  }

  static async create() {
    return new MemoryManager(await getStore(), await getVectorStore());
  }

  // ── Profile ────────────────────────────────────────────────────────────────
  getProfile(farmerId) {
    return this.store.getProfile(farmerId);
  }

  setProfileFact(farmerId, key, value, confidence) {
    logger.debug({ farmerId, key }, 'profile fact saved');
    return this.store.setProfileFact(farmerId, key, value, confidence);
  }

  // ── Episodic ─────────────────────────────────────────────────────────────
  async recordEpisodic({ farmerId, paddyId = null, type = 'observation', text, structured = {}, ttlDays }) {
    if (!farmerId || !text) throw new Error('recordEpisodic requires farmerId and text');
    const now = new Date().toISOString();
    const memory = {
      memoryId: nanoid(14),
      farmerId,
      paddyId,
      type,
      text,
      structured,
      season: currentSeason(),
      createdAt: now,
      lastAccessed: now,
      reinforcement: 0,
      expiresAt: ttlDays ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : null,
    };
    await this.store.putEpisodic(memory);
    try {
      const vec = await embedOne(`${type}: ${text}`);
      await this.vector.upsert(memory.memoryId, vec, {
        farmerId,
        paddyId: paddyId || '',
        memoryId: memory.memoryId,
      });
    } catch (err) {
      logger.warn({ err: err.message, memoryId: memory.memoryId }, 'vector upsert failed (memory still stored)');
    }
    logger.debug({ memoryId: memory.memoryId, farmerId, paddyId }, 'episodic memory recorded');
    return memory;
  }

  /**
   * Retrieve the most relevant memories for the current situation.
   * @returns {Promise<Array<memory & {score:number, semantic:number}>>}
   */
  async recall({ farmerId, paddyId = null, query = '', limit = 5 }) {
    const memories = await this.store.listEpisodic(farmerId, { paddyId });
    if (memories.length === 0) return [];

    const semanticById = new Map();
    if (query) {
      try {
        const qvec = await embedOne(query);
        const hits = await this.vector.query(qvec, { topK: limit * 4, filter: { farmerId } });
        // Use RANK, not the raw score: both adapters return best-first, but the
        // numeric score differs by metric (DashVector cosine returns a distance
        // where smaller is closer; local returns similarity). Rank is robust to
        // either: best hit → 1.0, decreasing toward 0.
        const denom = Math.max(hits.length, 1);
        hits.forEach((h, i) => semanticById.set(h.id, 1 - i / denom));
      } catch (err) {
        logger.warn({ err: err.message }, 'semantic query failed, ranking by recency only');
      }
    }

    const scored = memories.map((m) => {
      const semantic = semanticById.get(m.memoryId) ?? 0;
      const recency = recencyFactor(m.createdAt);
      const reinforcement = Math.min((m.reinforcement || 0) / 5, 1);
      const score = query
        ? WEIGHTS.semantic * semantic + WEIGHTS.recency * recency + WEIGHTS.reinforcement * reinforcement
        : 0.7 * recency + 0.3 * reinforcement;
      return { ...m, semantic, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    await Promise.all(top.map((m) => this.store.touchEpisodic(m).catch(() => {})));
    return top;
  }

  /**
   * Reinforce memories the agent actually relied on (called after a confirmed
   * decision) so useful experience resists forgetting.
   */
  async reinforce(memories) {
    await Promise.all(
      (memories || []).map((m) => this.store.touchEpisodic(m, { reinforce: true }).catch(() => {}))
    );
  }

  /**
   * Build a compact, token-efficient memory block for the system prompt.
   */
  async buildContext({ farmerId, paddyId = null, query = '', limit = 5 }) {
    const [profile, memories] = await Promise.all([
      this.getProfile(farmerId),
      this.recall({ farmerId, paddyId, query, limit }),
    ]);

    const profileLines = Object.entries(profile)
      .filter(([, v]) => v?.value !== undefined && v?.value !== '')
      .map(([k, v]) => `- ${k}: ${formatValue(v.value)}`);

    const memoryLines = memories.map((m) => {
      const when = m.createdAt?.slice(0, 10);
      const tag = m.paddyId ? `[${m.paddyId}]` : '[farm]';
      return `- (${when}, ${m.season}) ${tag} ${m.text}`;
    });

    return {
      profile,
      memories,
      text:
        `KNOWN FARMER PROFILE:\n${profileLines.join('\n') || '- (none yet)'}\n\n` +
        `RELEVANT PAST EXPERIENCE (most relevant first):\n${memoryLines.join('\n') || '- (none yet)'}`,
    };
  }

  /**
   * Autonomous memory accumulation: after a conversation turn, use a cheap Qwen
   * call to extract durable profile facts and episodic learnings, then persist.
   * This is what lets the agent "get smarter every season" without being told to.
   */
  async learnFromConversation({ farmerId, paddyId, transcript }) {
    if (!transcript?.trim()) return { profileFacts: [], episodic: [] };
    let extraction;
    try {
      extraction = await chatJSON({
        tier: 'router',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You extract durable memory from a conversation between an agronomy agent and a Thai farmer. ' +
              'Return JSON: {"profileFacts":[{"key":"snake_case","value":any,"confidence":0..1}],' +
              '"episodic":[{"type":"observation|preference|outcome|decision","text":"concise English fact worth remembering next season","structured":{}}]}. ' +
              'Only include genuinely durable facts (preferences, agronomic outcomes, recurring behaviour). ' +
              'Ignore small talk and transient sensor values. Empty arrays if nothing durable.',
          },
          { role: 'user', content: transcript.slice(0, 6000) },
        ],
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'memory extraction failed');
      return { profileFacts: [], episodic: [] };
    }

    const profileFacts = Array.isArray(extraction.profileFacts) ? extraction.profileFacts : [];
    const episodic = Array.isArray(extraction.episodic) ? extraction.episodic : [];

    await Promise.all([
      ...profileFacts.map((f) =>
        f?.key ? this.setProfileFact(farmerId, f.key, f.value, f.confidence ?? 0.7) : null
      ),
      ...episodic.map((e) =>
        e?.text
          ? this.recordEpisodic({
              farmerId,
              paddyId,
              type: e.type || 'observation',
              text: e.text,
              structured: e.structured || {},
            })
          : null
      ),
    ]);

    logger.info(
      { farmerId, facts: profileFacts.length, episodic: episodic.length },
      'learned durable memory from conversation'
    );
    return { profileFacts, episodic };
  }
}

function formatValue(v) {
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
