// ──────────────────────────────────────────────────────────────────────────
// Alibaba Cloud Tablestore (OTS) store — production driver.
//
// PROOF OF ALIBABA CLOUD: all persistent agent memory (farmer profiles,
// episodic field experience, sessions, and human-in-the-loop proposals) lives
// in Alibaba Cloud Tablestore. Episodic memories use Tablestore's native TTL so
// outdated experience is forgotten automatically ("timely forgetting").
//
// Primary key design (chosen so every query is a primary-key range, no scans
// of unrelated rows for the hot paths):
//   profiles   PK [farmerId, factKey]
//   episodic   PK [farmerId, memoryId]   (range-scan a farmer's memories)
//   sessions   PK [sessionId]
//   messages   PK [sessionId, ts]
//   proposals  PK [proposalId]
// ──────────────────────────────────────────────────────────────────────────
import TableStore from 'tablestore';
import { promisify } from 'node:util';
import config from '../../config.js';
import logger from '../../logger.js';

const TABLES = {
  profiles: 'nalog_agent_profiles',
  episodic: 'nalog_agent_episodic',
  sessions: 'nalog_agent_sessions',
  messages: 'nalog_agent_messages',
  proposals: 'nalog_agent_proposals',
};

// Episodic memories expire after ~2 growing seasons (≈ 400 days) unless rewritten.
const EPISODIC_TTL_SECONDS = 60 * 60 * 24 * 400;

function ignoreCondition() {
  return new TableStore.Condition(TableStore.RowExistenceExpectation.IGNORE, null);
}

function rowToObject(row) {
  if (!row || (!row.primaryKey && !row.attributes)) return null;
  const obj = {};
  for (const pk of row.primaryKey || []) obj[pk.name] = normalize(pk.value);
  for (const col of row.attributes || []) obj[col.columnName] = normalize(col.columnValue);
  return obj;
}

function normalize(value) {
  // Tablestore returns int64 as Long objects.
  if (value && typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  return value;
}

function jsonField(obj, key, fallback) {
  const raw = obj?.[key];
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export default class TablestoreStore {
  constructor() {
    const { endpoint, instance, accessKeyId, accessKeySecret } = config.storage.tablestore;
    if (!endpoint || !instance || !accessKeyId || !accessKeySecret) {
      throw new Error('Tablestore config incomplete: set TABLESTORE_* env vars');
    }
    this.client = new TableStore.Client({
      accessKeyId,
      secretAccessKey: accessKeySecret,
      endpoint,
      instancename: instance,
      maxRetries: 3,
    });
    this.getRow = promisify(this.client.getRow).bind(this.client);
    this.putRow = promisify(this.client.putRow).bind(this.client);
    this.updateRow = promisify(this.client.updateRow).bind(this.client);
    this.getRange = promisify(this.client.getRange).bind(this.client);
  }

  async init() {
    return this;
  }

  // ── Profile memory ─────────────────────────────────────────────────────────
  async getProfile(farmerId) {
    const res = await this.getRange({
      tableName: TABLES.profiles,
      direction: TableStore.Direction.FORWARD,
      inclusiveStartPrimaryKey: [{ farmerId }, { factKey: TableStore.INF_MIN }],
      exclusiveEndPrimaryKey: [{ farmerId }, { factKey: TableStore.INF_MAX }],
      limit: 200,
    });
    const profile = {};
    for (const row of res.rows || []) {
      const o = rowToObject(row);
      if (o?.factKey) {
        profile[o.factKey] = {
          value: jsonField(o, 'value', o.value),
          confidence: Number(o.confidence) || 0,
          updatedAt: o.updatedAt,
        };
      }
    }
    return profile;
  }

  async setProfileFact(farmerId, key, value, confidence = 0.8) {
    const updatedAt = new Date().toISOString();
    await this.putRow({
      tableName: TABLES.profiles,
      condition: ignoreCondition(),
      primaryKey: [{ farmerId }, { factKey: key }],
      attributeColumns: [
        { value: JSON.stringify(value) },
        { confidence },
        { updatedAt },
      ],
    });
    return { value, confidence, updatedAt };
  }

  // ── Episodic memory ──────────────────────────────────────────────────────
  async putEpisodic(memory) {
    await this.putRow({
      tableName: TABLES.episodic,
      condition: ignoreCondition(),
      primaryKey: [{ farmerId: memory.farmerId }, { memoryId: memory.memoryId }],
      attributeColumns: [
        { paddyId: memory.paddyId || '' },
        { type: memory.type || 'observation' },
        { text: memory.text || '' },
        { structured: JSON.stringify(memory.structured || {}) },
        { season: memory.season || '' },
        { createdAt: memory.createdAt },
        { lastAccessed: memory.lastAccessed || memory.createdAt },
        { reinforcement: memory.reinforcement || 0 },
        { expiresAt: memory.expiresAt || '' },
      ],
    });
    return memory;
  }

  async listEpisodic(farmerId, { paddyId } = {}) {
    const res = await this.getRange({
      tableName: TABLES.episodic,
      direction: TableStore.Direction.FORWARD,
      inclusiveStartPrimaryKey: [{ farmerId }, { memoryId: TableStore.INF_MIN }],
      exclusiveEndPrimaryKey: [{ farmerId }, { memoryId: TableStore.INF_MAX }],
      limit: 1000,
    });
    const now = Date.now();
    const memories = [];
    for (const row of res.rows || []) {
      const o = rowToObject(row);
      if (!o) continue;
      const mem = {
        memoryId: o.memoryId,
        farmerId: o.farmerId,
        paddyId: o.paddyId || null,
        type: o.type,
        text: o.text,
        structured: jsonField(o, 'structured', {}),
        season: o.season,
        createdAt: o.createdAt,
        lastAccessed: o.lastAccessed,
        reinforcement: Number(o.reinforcement) || 0,
        expiresAt: o.expiresAt || null,
      };
      if (mem.expiresAt && new Date(mem.expiresAt).getTime() < now) continue;
      if (paddyId && mem.paddyId && mem.paddyId !== paddyId) continue;
      memories.push(mem);
    }
    return memories;
  }

  async touchEpisodic(memory, { reinforce = false } = {}) {
    const lastAccessed = new Date().toISOString();
    const put = [{ lastAccessed }];
    if (reinforce) put.push({ reinforcement: (memory.reinforcement || 0) + 1 });
    await this.updateRow({
      tableName: TABLES.episodic,
      condition: ignoreCondition(),
      primaryKey: [{ farmerId: memory.farmerId }, { memoryId: memory.memoryId }],
      updateOfAttributeColumns: [{ PUT: put }],
    });
    return memory;
  }

  // Tablestore TTL handles physical deletion; vector cleanup is done lazily
  // during recall (see MemoryManager) when orphan entries are detected.
  async purgeExpired() {
    return [];
  }

  // ── Sessions & messages ────────────────────────────────────────────────────
  async getSession(sessionId) {
    const res = await this.getRow({
      tableName: TABLES.sessions,
      primaryKey: [{ sessionId }],
    });
    const o = rowToObject(res.row);
    if (!o) return null;
    return { sessionId: o.sessionId, ...jsonField(o, 'data', {}) };
  }

  async saveSession(session) {
    const { sessionId, ...rest } = session;
    await this.putRow({
      tableName: TABLES.sessions,
      condition: ignoreCondition(),
      primaryKey: [{ sessionId }],
      attributeColumns: [{ data: JSON.stringify(rest) }],
    });
    return session;
  }

  async appendMessage(sessionId, msg) {
    const ts = msg.ts || new Date().toISOString();
    await this.putRow({
      tableName: TABLES.messages,
      condition: ignoreCondition(),
      primaryKey: [{ sessionId }, { ts }],
      attributeColumns: [{ data: JSON.stringify(msg) }],
    });
    return msg;
  }

  async getMessages(sessionId, limit = 20) {
    const res = await this.getRange({
      tableName: TABLES.messages,
      direction: TableStore.Direction.BACKWARD,
      inclusiveStartPrimaryKey: [{ sessionId }, { ts: TableStore.INF_MAX }],
      exclusiveEndPrimaryKey: [{ sessionId }, { ts: TableStore.INF_MIN }],
      limit,
    });
    const msgs = (res.rows || []).map((r) => jsonField(rowToObject(r), 'data', {}));
    return msgs.reverse();
  }

  // ── HITL proposals ─────────────────────────────────────────────────────────
  async putProposal(proposal) {
    await this.putRow({
      tableName: TABLES.proposals,
      condition: ignoreCondition(),
      primaryKey: [{ proposalId: proposal.proposalId }],
      attributeColumns: [{ data: JSON.stringify(proposal) }],
    });
    return proposal;
  }

  async getProposal(proposalId) {
    const res = await this.getRow({
      tableName: TABLES.proposals,
      primaryKey: [{ proposalId }],
    });
    const o = rowToObject(res.row);
    return o ? jsonField(o, 'data', null) : null;
  }

  async updateProposal(proposalId, patch) {
    const current = await this.getProposal(proposalId);
    if (!current) return null;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.putProposal(updated);
    return updated;
  }

  async listProposals({ sessionId, status } = {}) {
    // Small table: range-scan all and filter in memory.
    const res = await this.getRange({
      tableName: TABLES.proposals,
      direction: TableStore.Direction.FORWARD,
      inclusiveStartPrimaryKey: [{ proposalId: TableStore.INF_MIN }],
      exclusiveEndPrimaryKey: [{ proposalId: TableStore.INF_MAX }],
      limit: 1000,
    });
    return (res.rows || [])
      .map((r) => jsonField(rowToObject(r), 'data', null))
      .filter(Boolean)
      .filter((p) => (sessionId ? p.sessionId === sessionId : true))
      .filter((p) => (status ? p.status === status : true))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // ── One-time provisioning helper (used by deploy/provision script) ──────────
  async provisionTables() {
    const createTable = promisify(this.client.createTable).bind(this.client);
    const defs = [
      { name: TABLES.profiles, pk: ['farmerId', 'factKey'], ttl: -1 },
      { name: TABLES.episodic, pk: ['farmerId', 'memoryId'], ttl: EPISODIC_TTL_SECONDS },
      { name: TABLES.sessions, pk: ['sessionId'], ttl: -1 },
      { name: TABLES.messages, pk: ['sessionId', 'ts'], ttl: -1 },
      { name: TABLES.proposals, pk: ['proposalId'], ttl: -1 },
    ];
    for (const def of defs) {
      try {
        await createTable({
          tableMeta: {
            tableName: def.name,
            primaryKey: def.pk.map((name) => ({
              name,
              type: TableStore.PrimaryKeyType.STRING,
            })),
          },
          reservedThroughput: { capacityUnit: { read: 0, write: 0 } },
          tableOptions: { timeToLive: def.ttl, maxVersions: 1 },
        });
        logger.info({ table: def.name }, 'created Tablestore table');
      } catch (err) {
        if (/exist/i.test(err.message)) {
          logger.info({ table: def.name }, 'Tablestore table already exists');
        } else {
          throw err;
        }
      }
    }
  }
}

export { TABLES, EPISODIC_TTL_SECONDS };
