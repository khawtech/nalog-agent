# Architecture

The NaLog Agent is a stateful **ReAct MemoryAgent**. A single Node service
(deployable as an Alibaba Cloud Function Compute ZIP custom runtime) orchestrates Qwen
reasoning, a three-tier memory system, a read-only connector to the NaLog IoT platform,
and a human-in-the-loop irrigation control path over LoRaWAN.

## System diagram

![Architecture](arch.png)

## Request flow (one turn)

1. **Authenticate** — the shared `AGENT_API_KEY` gates the API; the farmer's identity
   comes from a **cryptographically verified Firebase ID token** (`X-NaLog-Token`,
   RS256 signature against Google's rotating certs + `iss`/`aud`/`exp` checks — no
   heavyweight SDK). Memory, proposals and sessions are all scoped to that identity.
2. **See (optional)** — an attached field photo is analyzed by **`qwen3-vl-plus`**
   (`vision` tier) and the agronomic observation is injected into the turn.
3. **Load context** — fetch the farmer's profile + top-K relevant memories (vector-first
   semantic recall + rerank + recency + reinforcement), recent conversation, and a
   farm/paddy overview.
4. **Reason** — `qwen3.7-max` (`reason` tier, hybrid **thinking mode on**) runs a
   tool-calling loop (up to 6 rounds): `get_farm_overview`, `get_paddy_status`,
   `get_sensor_history`, `get_irrigation_history`, `recall_memory`, `save_memory`,
   `update_profile`, `analyze_field_photo`, `propose_irrigation`.
5. **Compose reply** — after tool rounds complete, `qwen3.6-plus` (`chat` tier,
   conversation-optimized, cheaper, thinking off) generates the farmer-facing response
   from the tool results. If no tools were needed, the reason-tier response is used
   directly.
6. **Stream** — with `Accept: text/event-stream` the whole turn streams as SSE:
   thinking deltas → live tool calls → reply tokens → final payload.
7. **Human-in-the-loop** — a pump action becomes a `proposal` (never executed directly),
   owned by and only decidable by its farmer.
8. **Persist & learn** — the turn is saved; a cheap `qwen3.6-flash` (`router` tier) pass
   extracts durable profile facts and episodic learnings autonomously, with
   **deduplication** (exact text + semantic vector similarity) to prevent near-duplicate
   memories.
9. **Purge** — expired memories are removed from the store and their vector entries
   deleted. For Tablestore, TTL handles row deletion; orphan vector entries are cleaned
   lazily during recall.
10. **Act locally (on approval)** — approving a proposal enqueues a ChirpStack downlink.

## Autonomous trigger (no human prompt)

`POST /api/alerts` is the machine-to-machine entry point: when a NaLog sensor crosses a
threshold, the platform posts the alert and the agent runs a **full unprompted reasoning
turn** — verifies the reading against live paddy state, recalls the farmer's history, and
creates an irrigation proposal if warranted. The proposal still requires the farmer's
approval before any LoRaWAN downlink: autonomy in analysis, humans in control of actuation.

## MCP surface

All 9 tool handlers are also exposed as a **Model Context Protocol (MCP) server** over
stdio ([`src/mcp/server.js`](../src/mcp/server.js)), built on `@modelcontextprotocol/sdk`.
This lets external MCP clients (Claude Desktop, Cursor, other agents) read NaLog field state,
query/append the farmer's memory, analyze field photos, and prepare human-in-the-loop
irrigation proposals — without duplicating any logic. One implementation, two integration
paths (web chat + MCP).

## Memory model

Three storage tiers, four-signal hybrid recall — matching the MemoryAgent track requirements:

| Tier | Store | Behaviour | Example |
|---|---|---|---|
| **Profile** (sticky) | Tablestore `profiles` | Rarely changes; high confidence | `preferred_language: th`, `irrigation_style: manual_approval` |
| **Episodic** (decaying) | Tablestore `episodic` + DashVector | Dated experience; TTL ~2 seasons; reinforced on reuse | "Paddy 3 drains +5→−15cm in ~4 days" |
| **Semantic recall** | DashVector + qwen3-rerank | Embeds the situation, returns the few most similar memories | "last time levels dropped this fast pre-flowering…" |

**Recall pipeline (vector-first, O(topK) regardless of history size):**

1. Embed the situation (`text-embedding-v3`) and query **DashVector** for candidate ids
   (`topK×4`, filtered by farmer).
2. Hydrate only those rows via **Tablestore point lookups** (`BatchGetRow`) — no range
   scan of a farmer's full multi-season history on the hot path.
3. Re-order candidates with the **`qwen3-rerank` cross-encoder** (reads query + memory
   together; falls back gracefully to vector order when unavailable).
4. Compute **BM25-inspired keyword overlap** between the query and each memory text
   (stopword-filtered token overlap fraction).
5. Blend the final relevance score across four signals:

```
score = 0.50 · semantic_rank            (rerank order, else DashVector order)
      + 0.10 · keyword_overlap          (BM25-inspired term match fraction)
      + 0.25 · recency                  (exp half-life ≈ 120 days)
      + 0.15 · reinforcement            (min(reuse_count / 5, 1))
```

The semantic leg uses **rank** (best candidate → 1.0, decreasing) rather than raw scores,
so it is robust to metric differences between DashVector (cosine distance), the local
dev index (similarity) and the reranker (relevance probability). The keyword leg adds a
lexical signal that catches exact term matches vectors might miss — proven necessary by
ablation (removing it leaks 5 stale facts).

Measured results (reproducible, `npm run bench`): see [BENCHMARK.md](BENCHMARK.md) —
the blend reaches **100% Recall@5** on the labeled set and always ranks the current fact
above its outdated twin, where a pure vector search serves stale facts twice as often.

**Timely forgetting** is threefold:
- *soft* — old, unused memories sink in ranking and stop being recalled;
- *consolidation* — before purging, expired memories are compressed into a concise summary
  via a cheap `qwen3.6-flash` call, preserving institutional knowledge (drain speeds, pest
  patterns, yield outcomes) in a single memory with an extended 800-day TTL;
- *hard* — Tablestore TTL physically deletes episodic rows after ~400 days unless rewritten.

**Memory lifecycle** — expired memories are purged from the store (with their vector entries
deleted in the same operation). For Tablestore, where TTL handles row deletion server-side,
orphan vector entries are cleaned lazily during recall: any vector hit that no longer has a
corresponding store row is deleted from the index.

**Reinforcement on use** — every memory that actually enters a turn (whether injected into
the context or explicitly re-requested by the model through `recall_memory`) gets its
reinforcement counter bumped, deduplicated per turn. Useful experience resists decay;
untouched notes fade.

**Deduplication** — the autonomous post-turn learning pass (`learnFromConversation`) checks
new memories against existing ones before inserting: exact text matches are reinforced
instead of duplicated, and semantic near-duplicates (cosine similarity > 0.85) are
reinforced instead of creating new entries. This prevents unbounded memory growth from
repeated conversations about the same topic.

**Limited context window** — recall is deliberately top-K (default 5) and summarised into a
compact block, never a full memory dump. This is what makes it viable for offline-first,
low-bandwidth rural deployments.

## Storage abstraction

The agent code is storage-agnostic. Drivers are selected by env:

| | `local` (dev/offline) | `alibaba` / `dashvector` (production) |
|---|---|---|
| Structured memory | JSON file (`LocalStore`) | **Tablestore** (`TablestoreStore`) |
| Vectors | in-process cosine (`LocalVector`) | **DashVector** |

This keeps development fast and tests deterministic while production uses managed Alibaba
Cloud services.

## Token-budget discipline (a judged criterion)

- **Model tiering** (deliberate per-phase routing):
  - `qwen3.7-max` (`reason` tier, thinking on) — tool-calling reasoning loop (the only
    phase that needs deep agronomic reasoning and function calling).
  - `qwen3.6-plus` (`chat` tier, thinking off) — farmer-facing NLG after tool rounds
    complete (conversation-optimized, cheaper). Also the safety net if the loop exhausts
    `MAX_TOOL_ROUNDS`.
  - `qwen3.6-flash` (`router` tier, thinking off) — background memory extraction
    (`learnFromConversation`). Cheapest model, sufficient for structured JSON extraction.
  - `qwen3-vl-plus` (`vision` tier) — only invoked when a photo is attached.
  - Embeddings stay on `text-embedding-v3` deliberately: the production DashVector
    collection lives in that vector space; changing models would require re-embedding
    every farmer's memories.
- **Summarised recall** rather than dumping raw history.
- **Per-turn token accounting** (concurrency-safe collector, not a process global)
  surfaced in the API response and the UI, plus a process-wide tally.
- **Retry with exponential backoff** on transient DashScope errors, so a blip doesn't
  waste an already-paid-for turn.

## Deploying on Alibaba Cloud

1. Create a Tablestore instance in Thailand `ap-southeast-7` (Bangkok). Create the
   DashVector cluster in Singapore `ap-southeast-1` — DashVector isn't offered in
   `ap-southeast-7`, so it (and Model Studio) are reached cross-region over HTTPS.
2. Put credentials in `.env` (`STORAGE_DRIVER=alibaba`, `VECTOR_DRIVER=dashvector`),
   and `FIREBASE_PROJECT_ID` so farmer tokens are verified in production.
3. `npm run provision` — creates tables (with TTL) and the vector collection.
4. `npm run deploy:build` then `npm run deploy:fc` — builds the code ZIP (Linux
   `node_modules` via Docker) and creates/updates the Function Compute function
   (ZIP-based **custom runtime**, `custom.debian10` with bundled Node 20 — no ACR)
   plus its HTTP trigger.
5. Point the NaLog farming frontend at the trigger URL (it forwards each farmer's
   Firebase ID token as `X-NaLog-Token`), and the platform's alert rules at
   `POST /api/alerts`.

## Security model

- `AGENT_API_KEY` — shared-secret gate on every API route (`x-api-key` or Bearer).
  Left empty only for the open local demo.
- `X-NaLog-Token` — the farmer's Firebase ID token. With `FIREBASE_PROJECT_ID` set the
  signature is verified against Google's public certs (kid lookup, RS256, iss/aud/exp);
  invalid tokens are rejected. Without a token, live mode returns 401 — only demo mode
  falls back to the bundled demo farmer.
- **Ownership checks** — proposals can only be viewed/approved/rejected by the farmer
  they belong to; sessions and `/api/memory` are scoped to the authenticated identity
  (the `?farmerId` override works in demo mode only).
- **CORS** — cross-origin browser access requires an explicit `ALLOWED_ORIGINS` entry;
  unset means same-origin only.

## Notes / known integration details

- NaLog's API ignores server-side time filters on sensor history, so the connector filters
  client-side.
- NaLog's process Lambda had a bug encoding every pump command as OFF; this agent encodes
  `on → 0x01` / `off → 0x00` correctly (see `src/integrations/chirpstack.js`).
- The production farmer channel is the NaLog web app (which speaks the same HTTP API and
  forwards Firebase tokens); this repo ships its own web chat UI for the demo.
