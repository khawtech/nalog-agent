# Proof of Alibaba Cloud Deployment

This document points judges to the exact code that demonstrates the backend runs on
**Alibaba Cloud** and uses Alibaba Cloud services and APIs. (A short screen recording of
the running backend accompanies the submission, separate from the demo video.)

> **This is a production system.** NaLog Agent is the same backend deployed on the live
> [KhawTECH](https://nalog-app.khawtech.com) NaLog platform, serving real smallholder farmers in
> Isan, Thailand. The codebase includes a demo mode for local development, but the
> production path uses all five Alibaba Cloud services listed below.

## 1. Qwen inference — Alibaba Cloud Model Studio (DashScope)

All language reasoning and natural-language generation is served by **Qwen** models hosted
on **Alibaba Cloud Model Studio**, via the OpenAI-compatible endpoint
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.

- **Base URL (literal):** [`config.js`](../src/config.js) — the Qwen base URL `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` is defined here.
- **Client initialisation:** [`dashscope.js`](../src/llm/dashscope.js) — creates the OpenAI SDK client pointed at the DashScope international endpoint.
- **4-tier model routing:** [`resolveModel()`](../src/llm/dashscope.js) — `qwen3.6-flash` for cheap extraction, `qwen3.6-plus` for chat NLG, `qwen3.7-max` (hybrid **thinking** enabled) for agronomic reasoning with tool calling, `qwen3-vl-plus` for field-photo analysis.
- **Chat completion + SSE streaming:** [`chat()` / `streamCompletion()`](../src/llm/dashscope.js) — every LLM call resolves the model tier and tracks token usage; streaming assembles content, thinking deltas, and tool-call fragments.
- **Hybrid-thinking control:** `enable_thinking` per tier (`QWEN_THINKING_TIERS`) — deep reasoning where it pays, low latency everywhere else.
- **JSON extraction:** [`chatJSON()`](../src/llm/dashscope.js) — structured memory extraction with `response_format: { type: 'json_object' }`.
- **Token accounting:** concurrency-safe per-turn collectors ([`newUsageCollector()`](../src/llm/dashscope.js)) plus a process tally, surfaced per turn in the API response; transient errors retried with exponential backoff.
- **Embeddings:** [`embed()`](../src/llm/embeddings.js) — `text-embedding-v3` at 1024 dimensions for semantic memory recall. Falls back to deterministic pseudo-embeddings when no API key is set (local dev only).
- **Reranking:** [`rerank.js`](../src/llm/rerank.js) — the `qwen3-rerank` cross-encoder (DashScope native rerank API) re-orders recalled memories; degrades gracefully to vector order.

## 2. Persistent memory — Alibaba Cloud Tablestore

Farmer profiles, episodic field experience (with native **TTL** for "timely forgetting"),
sessions, and human-in-the-loop proposals are stored in **Alibaba Cloud Tablestore**.

- **Full implementation:** [`tablestoreStore.js`](../src/memory/store/tablestoreStore.js) — uses the `tablestore` npm package (`^5.6.3`).
- **Table provisioning (incl. TTL):** [`provisionTables()`](../src/memory/store/tablestoreStore.js#L287-L318), invoked by [`deploy/provision.js`](../deploy/provision.js).
- **Profile storage:** [`getProfile()` / `setProfileFact()`](../src/memory/store/tablestoreStore.js) — PK-range queries on the `profiles` table.
- **Episodic memory:** [`putEpisodic()` / `listEpisodic()` / `touchEpisodic()`](../src/memory/store/tablestoreStore.js) — reinforcement counting and TTL-based physical deletion.
- **Hot-path point lookups:** [`getEpisodicByIds()`](../src/memory/store/tablestoreStore.js) — `BatchGetRow` hydration of DashVector candidates, so recall never range-scans a farmer's full history.
- **Sessions & proposals:** [`saveSession()` / `putProposal()` / `updateProposal()`](../src/memory/store/tablestoreStore.js) — HITL approval state persisted in Tablestore.
- **Driver switch:** [`getStore()`](../src/memory/store/index.js) — `STORAGE_DRIVER=alibaba` selects Tablestore; `local` selects JSON files for dev.

## 3. Semantic recall — Alibaba Cloud DashVector

Episodic memories are embedded and indexed in **Alibaba Cloud DashVector** for top-K
semantic recall.

- **HTTP client & config:** [`DashVector`](../src/memory/vector/dashVector.js#L12-L41) — DashVector REST API client.
- **Upsert:** [`upsert()`](../src/memory/vector/dashVector.js#L43-L47) — `/v1/collections/{collection}/docs/upsert` with 1024-dim vectors and metadata fields (farmerId, paddyId, memoryId).
- **Query:** [`query()`](../src/memory/vector/dashVector.js#L55-L65) — `/v1/collections/{collection}/docs/query` with topK and optional filter.
- **Delete:** [`delete()`](../src/memory/vector/dashVector.js#L49-L53) — `/v1/collections/{collection}/docs/delete`.
- **Driver switch:** [`getVectorStore()`](../src/memory/vector/index.js#L9-L12) — `VECTOR_DRIVER=dashvector` selects the cloud driver.

## 4. Serverless backend — Alibaba Cloud Function Compute 3.0

The agent runs as a **Function Compute 3.0 ZIP-based custom runtime** (`custom.debian10`,
bundled Node 20) with an anonymous HTTP trigger — no container image or Container Registry
required. It is deployed in Thailand (`ap-southeast-7`, Bangkok).

- **Build script:** [`fc-zip-build.sh`](../deploy/fc-zip-build.sh) — installs Linux `node_modules` in a Node 20 Debian image and zips the code package.
- **Deploy script:** [`fc-deploy.mjs`](../deploy/fc-deploy.mjs) — CreateFunction / CreateTrigger against the FC 3.0 API (`/2023-03-30`) with the ZIP as `code.zipFile`. Environment variables for all Alibaba Cloud services are injected here.
- **Entrypoint:** [`bootstrap`](../deploy/bootstrap) — starts the Express HTTP server inside the FC runtime.
- **Smoke test:** [`smoke-deployment.mjs`](../scripts/smoke-deployment.mjs) — hits `/healthz` and `/api/chat` on the live FC URL to verify the deployment is working end-to-end.

## 5. Production integration — NaLog / KhawTECH platform

This backend is not a standalone hackathon prototype — it is integrated into the live
KhawTECH NaLog platform:

- **Frontend:** The KhawTECH NaLog farmer dashboard connects to this backend via the FC HTTP trigger URL (same API the bundled `public/` chat UI uses for local demos).
- **Farmer identity:** Firebase ID tokens (`X-NaLog-Token`) scope all memory and farm data to the authenticated farmer ([`jwt.js`](../src/utils/jwt.js), [`chat.js`](../src/routes/chat.js)).
- **IoT pipeline:** Pump commands flow from this agent → ChirpStack → LoRaWAN gateway → physical pump relay in the field ([`chirpstack.js`](../src/integrations/chirpstack.js)).
- **Sensor data:** The agent reads live sensor data from the NaLog REST API ([`nalog.js`](../src/integrations/nalog.js)) — the same API that powers the farmer-facing dashboard.

## Security model (anonymous HTTP trigger)

The Function Compute HTTP trigger is configured with `authType: anonymous`. That only
means **Alibaba Cloud does not enforce RAM/JWT authentication at the FC gateway**.

**This does not mean the API is open.** Protection is applied in layers inside the application:

| Layer | What it does | Where |
|---|---|---|
| **Application API key** | Every API route requires `AGENT_API_KEY` via `x-api-key` or `Authorization: Bearer`. Requests without it get `401`. | [`auth.js`](../src/middleware/auth.js) |
| **Verified farmer identity** | The NaLog web app forwards the user's **Firebase ID token** (`X-NaLog-Token`). With `FIREBASE_PROJECT_ID` set (production), the token's **RS256 signature is verified against Google's rotating public certs**, plus `iss`/`aud`/`exp`/alg checks — forged or expired tokens get `401`. Memory, sessions and proposals are scoped to the verified uid; live mode without a token is rejected. | [`jwt.js`](../src/utils/jwt.js), [`auth.js`](../src/middleware/auth.js) |
| **Ownership enforcement** | Proposals can only be listed/viewed/approved/rejected by the farmer they belong to (`403` otherwise); `/api/memory` and session history are scoped to the authenticated identity. | [`proposals.js`](../src/routes/proposals.js), [`chat.js`](../src/routes/chat.js) |
| **CORS** | Cross-origin browser calls require an explicit `ALLOWED_ORIGINS` entry; unset means same-origin only. | [`server.js`](../src/server.js) |
| **Human-in-the-loop** | Pump commands are **proposals** only. A LoRaWAN downlink is sent only after an explicit approve action by the owning farmer. The autonomous alert webhook creates proposals but can never actuate. | [`proposals.js`](../src/routes/proposals.js), [`alerts.js`](../src/routes/alerts.js) |
| **Server-side secrets** | DashScope, Tablestore, DashVector, ChirpStack, and NaLog credentials live in FC environment variables — never returned to clients. | [`ENV_KEYS`](../deploy/fc-deploy.mjs) |

`GET /healthz` is intentionally unauthenticated: it returns only non-sensitive runtime
metadata (storage driver, model names) for ops and smoke tests.

## Verifying it live

```bash
# Health of the deployed Function Compute backend (no API key required):
curl https://<your-fc-trigger>.<region>.fcapp.run/healthz
# → { "status": "ok", "storage": "alibaba", "vector": "dashvector", "models": {...} }

# A full agent turn (Qwen + Tablestore + DashVector on Alibaba Cloud).
# Production requires AGENT_API_KEY on mutating endpoints:
curl -X POST https://<your-fc-trigger>.<region>.fcapp.run/api/chat \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <AGENT_API_KEY>' \
  -H 'X-NaLog-Token: <firebase-id-token>' \
  -d '{"message":"What is the water level in Paddy 3 and should I pump?"}'
```

The `/healthz` response reflects the live configuration (`storage: alibaba`,
`vector: dashvector`, Qwen model IDs), evidencing that the running backend is wired to
Alibaba Cloud services.
