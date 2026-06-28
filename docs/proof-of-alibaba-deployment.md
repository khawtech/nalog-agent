# Proof of Alibaba Cloud Deployment

This document points judges to the exact code that demonstrates the backend runs on
**Alibaba Cloud** and uses Alibaba Cloud services and APIs. (A short screen recording of
the running backend accompanies the submission, separate from the demo video.)

## 1. Qwen inference — Alibaba Cloud Model Studio (DashScope)

All language reasoning and natural-language generation is served by **Qwen** models hosted
on **Alibaba Cloud Model Studio**, via the OpenAI-compatible endpoint
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.

- Client: [`src/llm/dashscope.js`](../src/llm/dashscope.js) — model tiering
  (`qwen-turbo` / `qwen-plus` / `qwen-max`), tool calling, token accounting.
- Embeddings: [`src/llm/embeddings.js`](../src/llm/embeddings.js) — `text-embedding-v3`.

## 2. Persistent memory — Alibaba Cloud Tablestore

Farmer profiles, episodic field experience (with native **TTL** for "timely forgetting"),
sessions, and human-in-the-loop proposals are stored in **Alibaba Cloud Tablestore**.

- Implementation: [`src/memory/store/tablestoreStore.js`](../src/memory/store/tablestoreStore.js)
- Table provisioning (incl. TTL): `provisionTables()` in the same file, invoked by
  [`deploy/provision.js`](../deploy/provision.js).

## 3. Semantic recall — Alibaba Cloud DashVector

Episodic memories are embedded and indexed in **Alibaba Cloud DashVector** for top-K
semantic recall.

- Implementation: [`src/memory/vector/dashVector.js`](../src/memory/vector/dashVector.js)
  (HTTP API: `/v1/collections/{collection}/docs/upsert` and `/query`).

## 4. Serverless backend — Alibaba Cloud Function Compute 3.0

The agent runs as a **Function Compute 3.0 ZIP-based custom runtime** (`custom.debian10`,
bundled Node 20) with an anonymous HTTP trigger — no container image or Container Registry
required. It is deployed in Thailand (`ap-southeast-7`, Bangkok).

- Build: [`deploy/fc-zip-build.sh`](../deploy/fc-zip-build.sh) — installs Linux `node_modules`
  in a Node 20 Debian image and zips the code package.
- Deploy: [`deploy/fc-deploy.mjs`](../deploy/fc-deploy.mjs) — CreateFunction / CreateTrigger
  against the FC 3.0 API (`/2023-03-30`) with the ZIP as `code.zipFile`.
- Entrypoint: [`deploy/bootstrap`](../deploy/bootstrap) — starts the Express HTTP server.

## Security model (anonymous HTTP trigger)

The Function Compute HTTP trigger is configured with `authType: anonymous`. That only
means **Alibaba Cloud does not enforce RAM/JWT authentication at the FC gateway**.

**This does not mean the API is open.** Protection is applied in layers inside the application:

| Layer | What it does | Where |
|---|---|---|
| **Application API key** | All mutating routes (`POST /api/chat`, proposal approve/reject) require `AGENT_API_KEY` via `x-api-key` or `Authorization: Bearer`. Requests without it get `401`. | [`src/middleware/auth.js`](../src/middleware/auth.js), used in [`src/routes/chat.js`](../src/routes/chat.js) and [`src/routes/proposals.js`](../src/routes/proposals.js) |
| **Farmer identity** | The NaLog web app forwards the user's **Firebase ID token** (`X-NaLog-Token`). Memory and farm data are scoped to that farmer — the agent never trusts a bare `farmerId` from the body alone. | [`src/routes/chat.js`](../src/routes/chat.js), [`src/utils/jwt.js`](../src/utils/jwt.js) |
| **CORS** | Browser calls are restricted to origins listed in `ALLOWED_ORIGINS` (e.g. the NaLog dashboard). | [`src/server.js`](../src/server.js) |
| **Human-in-the-loop** | Pump commands are **proposals** only. A LoRaWAN downlink is sent only after an explicit approve action, and only when `REQUIRE_HUMAN_APPROVAL=true` (default). | [`src/routes/proposals.js`](../src/routes/proposals.js) |
| **Server-side secrets** | DashScope, Tablestore, DashVector, ChirpStack, and NaLog credentials live in FC environment variables — never returned to clients. | [`deploy/fc-deploy.mjs`](../deploy/fc-deploy.mjs) `ENV_KEYS` |

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
