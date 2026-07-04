import 'dotenv/config';
import path from 'node:path';

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 8080),
  logLevel: process.env.LOG_LEVEL || 'info',

  dashscope: {
    apiKey: process.env.DASHSCOPE_API_KEY || '',
    baseUrl:
      process.env.DASHSCOPE_BASE_URL ||
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: {
      router: process.env.MODEL_ROUTER || 'qwen3.6-flash',
      chat: process.env.MODEL_CHAT || 'qwen3.6-plus',
      reason: process.env.MODEL_REASON || 'qwen3.7-max',
      vision: process.env.MODEL_VISION || 'qwen3-vl-plus',
    },
    // Qwen hybrid-thinking policy: which tiers keep thinking mode enabled.
    // Default: only the reason tier (deep agronomic tool-use) thinks; the
    // chat/router tiers disable it to keep replies fast and cheap.
    thinkingTiers: (process.env.QWEN_THINKING_TIERS ?? 'reason')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // NOTE: embeddings deliberately stay on text-embedding-v3 — the production
    // DashVector collection was built in that vector space; changing models
    // would require a full re-embed migration of every farmer's memories.
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-v3',
    embeddingDim: int(process.env.EMBEDDING_DIM, 1024),
    // DashScope semantic reranker for memory recall. Empty string disables.
    rerankModel: process.env.RERANK_MODEL ?? 'qwen3-rerank',
    maxTokensPerTurn: int(process.env.MAX_TOKENS_PER_TURN, 6000),
  },

  firebase: {
    // When set, X-NaLog-Token Firebase ID tokens are cryptographically
    // verified (signature + iss + aud + exp) before trusting the uid.
    projectId: process.env.FIREBASE_PROJECT_ID || '',
  },

  storage: {
    driver: (process.env.STORAGE_DRIVER || 'local').toLowerCase(),
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    tablestore: {
      endpoint: process.env.TABLESTORE_ENDPOINT || '',
      instance: process.env.TABLESTORE_INSTANCE || '',
      accessKeyId: process.env.TABLESTORE_ACCESS_KEY_ID || '',
      accessKeySecret: process.env.TABLESTORE_ACCESS_KEY_SECRET || '',
    },
  },

  vector: {
    driver: (process.env.VECTOR_DRIVER || 'local').toLowerCase(),
    dashvector: {
      endpoint: process.env.DASHVECTOR_ENDPOINT || '',
      apiKey: process.env.DASHVECTOR_API_KEY || '',
      collection: process.env.DASHVECTOR_COLLECTION || 'nalog_memory',
    },
  },

  nalog: {
    apiUrl: (process.env.NALOG_API_URL || '').replace(/\/$/, ''),
    authToken: process.env.NALOG_AUTH_TOKEN || 'Bearer dummy',
    useDemo: bool(process.env.NALOG_USE_DEMO, true),
  },

  chirpstack: {
    apiUrl: (process.env.CHIRPSTACK_API_URL || '').replace(/\/$/, ''),
    apiToken: process.env.CHIRPSTACK_API_TOKEN || '',
  },

  requireHumanApproval: bool(process.env.REQUIRE_HUMAN_APPROVAL, true),

  // Optional shared-secret gate. When set, mutating endpoints (chat, proposal
  // approve/reject) require it. Left empty for the open local demo.
  agentApiKey: process.env.AGENT_API_KEY || '',

  // Comma-separated origins allowed for browser CORS (NaLog farming frontend).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export default config;
