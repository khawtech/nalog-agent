// ──────────────────────────────────────────────────────────────────────────
// Alibaba Cloud DashVector — production semantic memory index (HTTP API).
//
// PROOF OF ALIBABA CLOUD: semantic recall of past field experience is powered
// by Alibaba Cloud DashVector. We store one document per episodic memory
// (vector + {farmerId, paddyId, memoryId} fields) and query by cosine topK.
// Docs: https://help.aliyun.com/en/document_detail/2510320.html
// ──────────────────────────────────────────────────────────────────────────
import config from '../../config.js';
import logger from '../../logger.js';

export default class DashVector {
  constructor() {
    const { endpoint, apiKey, collection } = config.vector.dashvector;
    if (!endpoint || !apiKey) {
      throw new Error('DashVector config incomplete: set DASHVECTOR_ENDPOINT and DASHVECTOR_API_KEY');
    }
    this.base = endpoint.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.collection = collection;
  }

  async init() {
    return this;
  }

  async #request(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'dashvector-auth-token': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (json.code !== undefined && json.code !== 0)) {
      throw new Error(`DashVector ${path} failed: ${res.status} ${json.message || ''}`);
    }
    return json;
  }

  async upsert(id, vector, fields = {}) {
    await this.#request('POST', `/v1/collections/${this.collection}/docs/upsert`, {
      docs: [{ id, vector, fields }],
    });
  }

  async delete(id) {
    await this.#request('POST', `/v1/collections/${this.collection}/docs/delete`, {
      ids: [id],
    });
  }

  async query(vector, { topK = 5, filter = {} } = {}) {
    const body = { vector, topk: topK };
    const expr = buildFilter(filter);
    if (expr) body.filter = expr;
    const json = await this.#request('POST', `/v1/collections/${this.collection}/query`, body);
    return (json.output || []).map((d) => ({
      id: d.id,
      score: d.score,
      fields: d.fields || {},
    }));
  }

  // One-time provisioning helper (used by deploy/provision script).
  async provisionCollection() {
    try {
      await this.#request('POST', '/v1/collections', {
        name: this.collection,
        dimension: config.dashscope.embeddingDim,
        metric: 'cosine',
        fields_schema: { farmerId: 'STRING', paddyId: 'STRING', memoryId: 'STRING' },
      });
      logger.info({ collection: this.collection }, 'created DashVector collection');
    } catch (err) {
      if (/exist/i.test(err.message)) {
        logger.info({ collection: this.collection }, 'DashVector collection already exists');
      } else {
        throw err;
      }
    }
  }
}

// DashVector filter is a SQL-like boolean expression over fields.
function buildFilter(filter) {
  const clauses = [];
  for (const [k, v] of Object.entries(filter)) {
    if (v == null) continue;
    clauses.push(typeof v === 'number' ? `${k} = ${v}` : `${k} = '${String(v).replace(/'/g, "''")}'`);
  }
  return clauses.join(' AND ');
}
