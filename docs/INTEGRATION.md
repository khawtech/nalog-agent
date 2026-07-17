# Integration guide — using NaLog Agent with your own platform

NaLog Agent was built for the KhawTECH NaLog irrigation platform, but the architecture
is modular enough to power any agritech system that has farms, fields, and sensors.
This guide explains the three ways to integrate.

## Which path is right for you?

```
Do you have your own AI reasoning loop (Claude, Cursor, LangChain, etc.)?
 ├─ YES → Path 1: MCP memory-only     (use our memory, bring your own tools)
 │         OR Path 2: Full MCP         (use our memory + our domain tools)
 └─ NO  → Path 3: Platform connector   (replace nalog.js with your REST API)
```

| Path | Effort | What you get | What you provide |
|---|---|---|---|
| **1. MCP memory-only** | ~30 min | 3-tier memory with decay, contradiction detection, benchmarked recall | Your own domain tools + reasoning |
| **2. Full MCP** | ~1 hour | All 9 tools (memory + sensor reads + irrigation proposals) | A REST API matching the connector contract |
| **3. Platform connector** | ~1 day | The full agent (ReAct loop, web UI, SSE streaming, alerts, HITL) | A REST API or replacement `nalog.js` |

---

## Path 1 — MCP memory-only

Use NaLog Agent as a **memory backend** from your own MCP client. You call
`recall_memory`, `save_memory`, and `update_profile`; you ignore the
agronomy-specific tools (`get_paddy_status`, `propose_irrigation`, etc.).

### Setup

```bash
cp .env.example .env
# Set DASHSCOPE_API_KEY (required for embeddings + reranking)
# Leave everything else as default (local drivers, demo mode)
```

### Cursor / Claude Desktop (`.cursor/mcp.json` or `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "nalog-memory": {
      "command": "node",
      "args": ["src/mcp/server.js"],
      "cwd": "/path/to/nalog-agent",
      "env": {
        "DASHSCOPE_API_KEY": "sk-your-key",
        "MCP_FARMER_ID": "my-user-123",
        "STORAGE_DRIVER": "local",
        "VECTOR_DRIVER": "local",
        "NALOG_USE_DEMO": "true"
      }
    }
  }
}
```

### Key env vars for MCP

| Variable | Purpose | Default |
|---|---|---|
| `MCP_FARMER_ID` | User/tenant identity for memory scoping | `farmer-somchai` (demo) |
| `DASHSCOPE_API_KEY` | Required for embeddings (`text-embedding-v3`) and reranking (`qwen3-rerank`) | — |
| `STORAGE_DRIVER` | `local` (JSON file) or `alibaba` (Tablestore) | `local` |
| `VECTOR_DRIVER` | `local` (in-process cosine) or `dashvector` | `local` |
| `DATA_DIR` | Where `local` driver persists memory | `./data` |
| `NALOG_USE_DEMO` | Set `true` so domain tools don't fail when you don't have a NaLog API | `true` |

### Memory tools available via MCP

| Tool | What it does |
|---|---|
| `recall_memory` | Vector-first semantic recall with reranking, decay, and reinforcement scoring. Returns the top-K most relevant memories for the user. |
| `save_memory` | Store a new episodic memory (observation, preference, outcome, decision). Automatically embedded for future recall. |
| `update_profile` | Set a durable profile fact (key/value with confidence). Profile facts don't decay. |

### Memory features you get for free

- **3-tier recall scoring**: 60% semantic (vector + cross-encoder rerank), 25% recency
  (120-day half-life), 15% reinforcement (use-count).
- **Contradiction detection**: new facts in similarity range 0.50–0.85 trigger LLM
  adjudication; superseded memories are kept for audit but excluded from recall.
- **Near-duplicate dedup**: exact text match and semantic similarity ≥ 0.85 reinforce
  existing memories instead of creating duplicates.
- **Hard forgetting**: Tablestore TTL (~400 days) or manual purge.
- **Orphan cleanup**: vector entries whose store rows expired are cleaned lazily.

### Docker alternative

```bash
docker compose run --rm -e MCP_FARMER_ID=my-user-123 app npm run mcp
```

---

## Path 2 — Full MCP (memory + domain tools)

Same as Path 1 but you also call the domain tools: `get_farm_overview`,
`get_paddy_status`, `get_sensor_history`, `get_irrigation_history`,
`analyze_field_photo`, `propose_irrigation`.

For this to work, domain tools need data. Two options:

### Option A: Use demo data

Set `NALOG_USE_DEMO=true` (default). The agent uses a bundled Kut Chum, Yasothon
farm with rice and sugarcane paddies, AWD sensors, and generated sensor history.
Good for evaluation and testing.

### Option B: Point to your own REST API

Set `NALOG_USE_DEMO=false` and configure:

```env
NALOG_API_URL=https://your-platform.example.com
NALOG_AUTH_TOKEN=Bearer your-token
```

Your API must implement the endpoints documented in
[`CONNECTOR-API.md`](CONNECTOR-API.md). The shapes are simple REST/JSON — see the
demo dataset in [`src/integrations/demoData.js`](../src/integrations/demoData.js)
for exact field names and types.

---

## Path 3 — Platform connector (full agent)

You want the complete NaLog Agent experience — web UI, SSE streaming, ReAct loop,
autonomous alerts, human-in-the-loop proposals — but connected to **your** platform
instead of NaLog.

### What to change

There are four files to modify and one to extend. Everything else (memory, LLM,
auth, routes, MCP) works unchanged.

#### 1. `src/integrations/nalog.js` → your platform connector

This is the **only file that talks to your external API**. Replace the `apiGet()`
calls with your own REST client. The public functions the agent calls are:

| Function | What the agent expects back |
|---|---|
| `getFarms(token)` | Array of `{ farmId, name, description?, location? }` |
| `getPaddies(farmId, token)` | Array of paddy objects (see schema below) |
| `getPaddy(paddyId, token)` | Single paddy object or `null` |
| `getSensorsForFarm(farmId, token)` | Array of `{ sensorId, farmId, paddyId, name, type, devEUI?, battery? }` |
| `getAWDCycle(paddyId, token)` | AWD cycle object or `null` (rice only) |
| `getSensorHistory(sensorId, hours, token)` | Array of `{ timestamp, payload: { level?, moisture?, value? } }` |
| `getPumpControls(farmId, token)` | Array of pump control events |
| `getIrrigationEvents(farmId, token, opts)` | Array of irrigation events |
| `getPaddyStatus(paddyId, token)` | Aggregated paddy view (or keep the built-in stitcher) |

Full schemas and example payloads: [`CONNECTOR-API.md`](CONNECTOR-API.md).

**Tip:** You don't have to implement every function. If you don't have AWD cycles,
return `null` from `getAWDCycle`. If you don't track irrigation events, return `[]`
from `getIrrigationEvents`. The agent degrades gracefully — it uses what's available
and tells the farmer when data is missing.

#### 2. `src/integrations/demoData.js` → your demo dataset

Replace the demo farm, paddies, and sensors with examples from your platform.
The shapes must match what your connector returns so that `NALOG_USE_DEMO=true`
still works for development and tests.

#### 3. `src/agent/prompts.js` → your domain knowledge

Replace the `AGRONOMY_KNOWLEDGE` constant with your crop/domain rules:

```js
export const AGRONOMY_KNOWLEDGE = `
Your domain-specific knowledge here. Examples:
- Soil moisture thresholds for your crop type
- Growth stage definitions and irrigation rules
- Safety rules (when NOT to irrigate)
`;
```

Update the `buildSystemPrompt()` function to reference your domain terminology
instead of "paddy", "AWD", "rice", "sugarcane" if needed.

#### 4. `src/integrations/chirpstack.js` → your actuation layer

If your platform controls physical devices (pumps, valves, gates), replace the
ChirpStack downlink with your own command API. If you don't have device control,
you can skip this — proposals will still be created and stored, just not actuated.

Set `CHIRPSTACK_API_URL` and `CHIRPSTACK_API_TOKEN` to empty and the agent will
log simulated commands.

#### 5. `src/agent/tools.js` → add or modify tools (optional)

The tool definitions use OpenAI function-calling schema. To add a new tool:

1. Add the schema to `toolDefinitions` array
2. Add the handler to the `handlers` object
3. Register it in `src/mcp/server.js` if you want MCP access

Example — adding a soil analysis tool:

```js
// In toolDefinitions:
{
  type: 'function',
  function: {
    name: 'get_soil_analysis',
    description: 'Get the latest soil lab results for a field.',
    parameters: {
      type: 'object',
      properties: {
        fieldId: { type: 'string' },
      },
      required: ['fieldId'],
    },
  },
}

// In handlers:
async get_soil_analysis({ fieldId }, ctx) {
  const result = await yourApi.getSoilAnalysis(fieldId, ctx.nalogToken);
  return result || { error: `No soil data for ${fieldId}` };
}
```

### What you keep unchanged

| Component | Why it just works |
|---|---|
| **Memory system** | `MemoryManager` is domain-agnostic. It stores text + vectors per user. |
| **LLM layer** | `src/llm/dashscope.js` — Qwen model routing, streaming, embeddings, reranking. |
| **Auth** | Firebase ID tokens or API key — identity is a string, not NaLog-specific. |
| **Routes** | `/api/chat`, `/api/proposals`, `/api/alerts`, `/healthz` — all work with any connector. |
| **Web UI** | `public/` — the chat panel, approval cards, and memory panel render whatever the agent returns. |
| **Tests** | Run with `NALOG_USE_DEMO=true` against your demo dataset. |

---

## Storage drivers

Memory persistence is handled by swappable drivers. No code changes needed.

| Driver | Config | Good for |
|---|---|---|
| `local` | `STORAGE_DRIVER=local`, `DATA_DIR=./data` | Development, single-instance, demos |
| `alibaba` | `STORAGE_DRIVER=alibaba`, `TABLESTORE_*` vars | Production (durable, multi-instance) |

| Driver | Config | Good for |
|---|---|---|
| `local` | `VECTOR_DRIVER=local` | Development (in-process brute-force cosine) |
| `dashvector` | `VECTOR_DRIVER=dashvector`, `DASHVECTOR_*` vars | Production (ANN index, scales) |

You could add your own driver (e.g. PostgreSQL, Redis) by implementing the same
interface as `LocalStore` / `LocalVector`. See
[`src/memory/store/localStore.js`](../src/memory/store/localStore.js) and
[`src/memory/vector/localVector.js`](../src/memory/vector/localVector.js) for the
contract.

### Store interface

```js
class YourStore {
  async init()                                    // → this
  async getProfile(farmerId)                      // → { key: { value, confidence, updatedAt } }
  async setProfileFact(farmerId, key, value, confidence)
  async putEpisodic(memory)                       // upsert
  async getEpisodic(memoryId)                     // → memory | null
  async getEpisodicByIds(farmerId, ids)           // → [memory]
  async listEpisodic(farmerId)                    // → [memory]
  async touchEpisodic(memory, opts?)              // update lastAccessed, optionally reinforce
  async purgeExpired()                             // → [removedMemoryId]
  async putProposal(proposal)
  async getProposal(proposalId)
  async updateProposal(proposalId, updates)
  async putSession(session)
  async getSession(sessionId)
  async appendMessages(sessionId, messages)
  async getMessages(sessionId)
}
```

### Vector interface

```js
class YourVector {
  async init()                                    // → this
  async upsert(id, vector, metadata)
  async query(vector, { topK, filter })           // → [{ id, score }]
  async delete(id)
}
```

---

## Farmer identity and multi-tenancy

All memory is scoped to a `farmerId` string. The agent never mixes memories across
farmers.

| Mode | How `farmerId` is determined |
|---|---|
| **Demo** | Hardcoded `farmer-somchai` from `demoData.js` |
| **MCP** | `MCP_FARMER_ID` env var, or extracted from `NALOG_AUTH_TOKEN` if it's a valid JWT |
| **Web API** | Firebase UID from the `X-NaLog-Token` header (cryptographically verified) |
| **Your system** | Replace the auth middleware in `src/middleware/auth.js` to extract your user ID |

To use your own auth instead of Firebase:

```js
// src/middleware/auth.js — replace verifyFirebaseToken() with your own
export function requireFarmerIdentity(req, res, next) {
  const userId = extractYourUserId(req);  // your logic
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  req.farmerId = userId;
  next();
}
```

---

## Deployment options

| Option | Setup |
|---|---|
| **Docker (local)** | `docker compose up` — everything in one container |
| **Alibaba Cloud Function Compute** | `npm run deploy:build && npm run deploy:fc` — ZIP custom runtime, no container registry |
| **Any Node.js host** | `npm start` — standard Express server, port via `PORT` env |
| **Behind a reverse proxy** | Set `ALLOWED_ORIGINS` for CORS; the agent is a stateless HTTP service |

---

## Example: vineyard monitoring platform

Say you run a vineyard IoT platform with soil moisture sensors and drip valves.

1. **Copy `src/integrations/nalog.js` → `src/integrations/vineyard.js`**
   - `getFarms()` returns your vineyards
   - `getPaddies()` returns your vineyard blocks/zones
   - `getSensorsForFarm()` returns your soil moisture probes
   - `getSensorHistory()` returns your moisture readings
   - `getAWDCycle()` → return `null` (not applicable)
   - `getPumpControls()` returns your drip valve events

2. **Update imports in `src/agent/tools.js`:**
   ```js
   import * as nalog from '../integrations/vineyard.js';
   ```

3. **Replace domain knowledge in `src/agent/prompts.js`:**
   ```js
   export const AGRONOMY_KNOWLEDGE = `
   Grapevine irrigation — soil moisture is measured in % volumetric water content:
   - Deficit irrigation: maintain 25-35% VWC during véraison for quality
   - Full irrigation: maintain 40-50% VWC during shoot growth
   - STOP irrigation 2-3 weeks before harvest
   ...`;
   ```

4. **Replace demo data in `src/integrations/demoData.js`** with a sample
   vineyard block and sensor.

5. **Replace ChirpStack** with your valve control API, or leave it as simulated.

The memory system, LLM layer, web UI, MCP server, auth, tests, and benchmark
all work unchanged. Your vineyard agent remembers which blocks drain faster,
which varieties need more water during véraison, and what worked last harvest.
