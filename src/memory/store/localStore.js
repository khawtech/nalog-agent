// ──────────────────────────────────────────────────────────────────────────
// Local file-backed store (development / offline). Mirrors the TablestoreStore
// interface so the agent code is storage-agnostic. Atomic writes via temp+rename.
// ──────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import logger from '../../logger.js';

export default class LocalStore {
  constructor(dataDir = config.storage.dataDir) {
    this.file = path.join(dataDir, 'memory-db.json');
    this.dataDir = dataDir;
    this.db = {
      profiles: {}, // farmerId -> { key -> {value, confidence, updatedAt} }
      episodic: {}, // memoryId -> memory
      sessions: {}, // sessionId -> session
      messages: {}, // sessionId -> [msg]
      proposals: {}, // proposalId -> proposal
    };
  }

  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.db = { ...this.db, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      } catch (err) {
        logger.warn({ err: err.message }, 'could not parse local memory db, starting fresh');
      }
    }
    return this;
  }

  #flush() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ── Profile memory (sticky) ──────────────────────────────────────────────
  async getProfile(farmerId) {
    return this.db.profiles[farmerId] || {};
  }

  async setProfileFact(farmerId, key, value, confidence = 0.8) {
    const profile = this.db.profiles[farmerId] || (this.db.profiles[farmerId] = {});
    profile[key] = { value, confidence, updatedAt: new Date().toISOString() };
    this.#flush();
    return profile[key];
  }

  // ── Episodic memory (decaying) ─────────────────────────────────────────────
  async putEpisodic(memory) {
    this.db.episodic[memory.memoryId] = memory;
    this.#flush();
    return memory;
  }

  async getEpisodic(memoryId) {
    return this.db.episodic[memoryId] || null;
  }

  async listEpisodic(farmerId, { paddyId } = {}) {
    const now = Date.now();
    return Object.values(this.db.episodic).filter((m) => {
      if (m.farmerId !== farmerId) return false;
      if (paddyId && m.paddyId && m.paddyId !== paddyId) return false;
      if (m.expiresAt && new Date(m.expiresAt).getTime() < now) return false;
      return true;
    });
  }

  async touchEpisodic(memory, { reinforce = false } = {}) {
    const m = this.db.episodic[memory.memoryId];
    if (!m) return null;
    m.lastAccessed = new Date().toISOString();
    if (reinforce) m.reinforcement = (m.reinforcement || 0) + 1;
    this.#flush();
    return m;
  }

  async purgeExpired() {
    const now = Date.now();
    const removed = [];
    for (const [id, m] of Object.entries(this.db.episodic)) {
      if (m.expiresAt && new Date(m.expiresAt).getTime() < now) {
        delete this.db.episodic[id];
        removed.push(id);
      }
    }
    if (removed.length) this.#flush();
    return removed;
  }

  // ── Sessions & messages (cross-session continuity) ────────────────────────
  async getSession(sessionId) {
    return this.db.sessions[sessionId] || null;
  }

  async saveSession(session) {
    this.db.sessions[session.sessionId] = session;
    this.#flush();
    return session;
  }

  async appendMessage(sessionId, msg) {
    const list = this.db.messages[sessionId] || (this.db.messages[sessionId] = []);
    list.push(msg);
    this.#flush();
    return msg;
  }

  async getMessages(sessionId, limit = 20) {
    const list = this.db.messages[sessionId] || [];
    return list.slice(-limit);
  }

  // ── HITL proposals ─────────────────────────────────────────────────────────
  async putProposal(proposal) {
    this.db.proposals[proposal.proposalId] = proposal;
    this.#flush();
    return proposal;
  }

  async getProposal(proposalId) {
    return this.db.proposals[proposalId] || null;
  }

  async updateProposal(proposalId, patch) {
    const p = this.db.proposals[proposalId];
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    this.#flush();
    return p;
  }

  async listProposals({ sessionId, status } = {}) {
    return Object.values(this.db.proposals)
      .filter((p) => (sessionId ? p.sessionId === sessionId : true))
      .filter((p) => (status ? p.status === status : true))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
}
