// ──────────────────────────────────────────────────────────────────────────
// Local in-process vector index (development / offline). Persists vectors to a
// JSON sidecar and ranks by cosine similarity. Mirrors DashVector's interface.
// ──────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import logger from '../../logger.js';
import { cosineSimilarity } from '../../llm/embeddings.js';

export default class LocalVector {
  constructor(dataDir = config.storage.dataDir) {
    this.file = path.join(dataDir, 'vectors.json');
    this.dataDir = dataDir;
    this.docs = new Map(); // id -> { id, vector, fields }
  }

  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const d of arr) this.docs.set(d.id, d);
      } catch (err) {
        logger.warn({ err: err.message }, 'could not parse local vectors, starting fresh');
      }
    }
    return this;
  }

  #flush() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.docs.values()]));
    fs.renameSync(tmp, this.file);
  }

  async upsert(id, vector, fields = {}) {
    this.docs.set(id, { id, vector, fields });
    this.#flush();
  }

  async delete(id) {
    if (this.docs.delete(id)) this.#flush();
  }

  /**
   * @returns {Promise<Array<{id, score, fields}>>}
   */
  async query(vector, { topK = 5, filter = {} } = {}) {
    const results = [];
    for (const doc of this.docs.values()) {
      if (!matchesFilter(doc.fields, filter)) continue;
      results.push({ id: doc.id, score: cosineSimilarity(vector, doc.vector), fields: doc.fields });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

function matchesFilter(fields, filter) {
  for (const [k, v] of Object.entries(filter)) {
    if (v == null) continue;
    if (fields[k] !== v) return false;
  }
  return true;
}
