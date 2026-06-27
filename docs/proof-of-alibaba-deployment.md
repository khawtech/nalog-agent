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

## Verifying it live

```bash
# Health of the deployed Function Compute backend:
curl https://<your-fc-trigger>.<region>.fcapp.run/healthz
# → { "status": "ok", "storage": "alibaba", "vector": "dashvector", "models": {...} }

# A full agent turn (Qwen + Tablestore + DashVector on Alibaba Cloud):
curl -X POST https://<your-fc-trigger>.<region>.fcapp.run/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is the water level in Paddy 3 and should I pump?"}'
```

The `/healthz` response reflects the live configuration (`storage: alibaba`,
`vector: dashvector`, Qwen model IDs), evidencing that the running backend is wired to
Alibaba Cloud services.
