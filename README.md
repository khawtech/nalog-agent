# NaLog Agent 🌾

[![CI](https://github.com/khawtech/nalog-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/khawtech/nalog-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

> A **Qwen-powered MemoryAgent** that helps smallholder rice & sugarcane farmers in
> Isan, Thailand make better, cheaper irrigation decisions — and gets smarter every
> season by remembering each farmer and each paddy.
>
> Built on **Alibaba Cloud** (Model Studio / Qwen, Function Compute, Tablestore,
> DashVector) on top of the [NaLog / KhawTECH](https://khawtech.com) IoT irrigation platform.

> **Production system.** This is the same backend that powers the NaLog Agent in the
> live [KhawTECH](https://nalog-app.khawtech.com) SaaS platform, serving real farmers in Isan,
> Thailand. It runs on Alibaba Cloud Function Compute in Bangkok (`ap-southeast-7`)
> with Tablestore, DashVector, and Model Studio. The demo mode included here uses a
> bundled dataset so anyone can run it locally — but the production path is already
> deployed and handling real conversations, real sensors, and real pump commands.

**Hackathon track:** **Track 1 — MemoryAgent** + **Track 4 — Autopilot Agent**
(dual-track: the 3-tier decaying memory system fulfils Track 1, while the autonomous
`POST /api/alerts` webhook — sensor alert → unprompted agronomic reasoning →
human-in-the-loop pump approval → LoRaWAN downlink to the field — satisfies Track 4's
production workflow criteria. See [Dual-track rationale](#dual-track-rationale) below.)

> **Built by [Alberto Roura](https://albertoroura.com)** — **Alibaba Cloud MVP for 8
> consecutive years (2018–2026)** and **Alibaba Cloud MVP of the Year 2019** (awarded
> globally at the MVP Global Summit). Apsara Conference organizer & co-presenter (covered
> the Hanguang 800 AI chip launch on Alibaba's channels) and a **Qwen VIP**. This project
> is the agritech mission I've been building toward: putting world-class Alibaba Cloud AI
> into the hands of farmers who could never normally afford it.

---

## Why this exists

KhawTECH puts affordable AWD (Alternate Wetting and Drying) sensors in the fields of
smallholder farmers who can't afford big-ag technology. The sensors produce data — but
raw data isn't advice. Good agronomic guidance has to be **hyper-local and remembered**:
*this* paddy drains faster after re-levelling, *this* farmer prefers to approve the pump
himself near flowering, *last* season AWD here cut pumping 31% with no yield loss.

The NaLog Agent is the agronomist with perfect memory in every farmer's pocket. It:

- **Accumulates experience** per farmer and per paddy, across sessions and seasons.
- **Forgets in a timely way** — memories decay with age and are physically expired via
  Tablestore TTL unless they keep proving useful (reinforcement). Measured, not claimed:
  see the [reproducible benchmark](docs/BENCHMARK.md).
- **Recalls within a tiny context window** — vector-first top-K recall (DashVector +
  `qwen3-rerank` cross-encoder) + summarisation, so it works for offline-first,
  low-bandwidth rural deployments.
- **Sees the field** — attach a photo and `qwen3-vl-plus` reads crop condition, water,
  pests and weeds into the reasoning loop.
- **Acts autonomously, but never blindly** — sensor alerts trigger unprompted reasoning
  turns (`POST /api/alerts`); any pump action is a *proposal* a human approves; only then
  is a LoRaWAN downlink sent.
- **Streams its work** — SSE streaming of Qwen thinking, live tool calls, and the reply,
  so the farmer watches the agent check real sensors before trusting its advice.
- **Interoperable** — the same capabilities are exposed as an **MCP server**, so any MCP
  client (Claude, Cursor, other agents) can use NaLog's tools. See [Use it from any MCP
  client](#use-it-from-any-mcp-client).

## Architecture

![Architecture](docs/arch.png)

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and the
[3-tier memory model](docs/ARCHITECTURE.md#memory-model).

## Alibaba Cloud services used (proof of deployment)

| Service | Used for | Code |
|---|---|---|
| **Model Studio (Qwen)** | 4-tier model routing: `qwen3.7-max` (thinking, tool use) · `qwen3.6-plus` (Thai/English NLG) · `qwen3.6-flash` (memory extraction) · `qwen3-vl-plus` (field photos); SSE streaming | [`dashscope.js`](src/llm/dashscope.js), [`tools.js`](src/agent/tools.js) |
| **Model Studio (embeddings)** | Semantic memory vectors (`text-embedding-v3`) | [`embed()`](src/llm/embeddings.js) |
| **Model Studio (rerank)** | `qwen3-rerank` cross-encoder re-ordering of recalled memories | [`rerank.js`](src/llm/rerank.js) |
| **Tablestore** | Persistent memory (profile, episodic w/ TTL, sessions, proposals); `BatchGetRow` point lookups on the recall hot path | [`tablestoreStore.js`](src/memory/store/tablestoreStore.js) |
| **DashVector** | Vector-first semantic recall of past field experience | [`dashVector.js`](src/memory/vector/dashVector.js) |
| **Function Compute 3.0** | Serverless backend (ZIP custom runtime, no ACR) | [`fc-zip-build.sh`](deploy/fc-zip-build.sh), [`fc-deploy.mjs`](deploy/fc-deploy.mjs) |

The single-file backend-on-Alibaba proof for judges is
[`docs/proof-of-alibaba-deployment.md`](docs/proof-of-alibaba-deployment.md).

## Quick start (local, Docker)

```bash
cp .env.example .env          # add your DASHSCOPE_API_KEY (Model Studio)
docker compose build
docker compose run --rm app npm run seed   # seed the demo farmer's memory
docker compose up                          # http://localhost:8080
```

Defaults run fully offline-capable: `STORAGE_DRIVER=local`, `VECTOR_DRIVER=local`,
`NALOG_USE_DEMO=true` (a built-in Kut Chum, Yasothon demo farm). Only a Model Studio
API key is required to talk to Qwen.

The bundled web chat UI (`public/`) streams the agent's work live (thinking → tool calls
→ reply tokens), shows an expandable tool trace per answer, renders approval cards for
pump proposals, lets you attach a field photo (Qwen-VL), and has a memory panel showing
what the agent remembers (with reinforcement counters).

Try asking (Thai or English):
- *"นาแปลง 3 ตอนนี้ต้องสูบน้ำไหม?"* ("Does Paddy 3 need pumping now?")
- *"What's the water level in Paddy 3 and what do you recommend?"*

The agent reads the (demo) sensor trend, recalls past experience, and — if a pump action
makes sense — shows an **approval card**. Approving it sends the LoRaWAN downlink (simulated
unless `CHIRPSTACK_*` is configured).

Simulate the autonomous Track-4 path (sensor alert → unprompted agent turn → proposal):

```bash
curl -X POST http://localhost:8080/api/alerts -H 'Content-Type: application/json' \
  -d '{"paddyId":"paddy-rice-3","metric":"water_level","value":-16.2,"unit":"cm","threshold":-15,"direction":"below"}'
```

## Production deployment on Alibaba Cloud

This repo is the **same codebase running in production** at KhawTECH. Switch from local
dev to production by changing the driver env vars:

1. Provision storage: set `STORAGE_DRIVER=alibaba`, `VECTOR_DRIVER=dashvector` and the
   `TABLESTORE_*` / `DASHVECTOR_*` vars in `.env`, then:
   ```bash
   docker compose run --rm app npm run provision
   ```
2. Build the code package and deploy to Function Compute (ZIP-based custom runtime —
   no container image / ACR needed):
   ```bash
   npm run deploy:build    # builds dist/nalog-agent-fc.zip (Linux node_modules via Docker)
   npm run deploy:fc       # creates/updates the FC function + HTTP trigger
   ```
   Function Compute and Tablestore run in Thailand `ap-southeast-7` (Bangkok) by default.
   DashVector and Model Studio aren't offered there, so they stay on their Singapore/global
   endpoints and are reached over HTTPS.
3. Smoke-test the live deployment end-to-end:
   ```bash
   BASE_URL=https://<your-fc-trigger>.ap-southeast-7.fcapp.run npm run smoke:deploy
   ```
4. (Optional) Open the live web UI as a real farmer — mint a short-lived Firebase ID
   token and get a ready-to-open URL (needs `FIREBASE_WEB_API_KEY` in `.env` and a
   service-account JSON at `local/firebase-service-account.json`):
   ```bash
   BASE_URL=https://<your-fc-trigger>.ap-southeast-7.fcapp.run \
     node scripts/firebase-test-token.mjs <farmer-uid>
   ```

In production, the KhawTECH NaLog farmer web app connects to this backend via the
Function Compute HTTP trigger, forwarding the farmer's Firebase ID token for identity
scoping.

Full steps: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`deploy/fc-zip-build.sh`](deploy/fc-zip-build.sh)
and [`deploy/fc-deploy.mjs`](deploy/fc-deploy.mjs).

**Deploy-only dependencies** (not needed for local dev or tests):
```bash
npm install --no-save @alicloud/fc20230330 @alicloud/openapi-client @alicloud/tea-util
```
## Use it from any MCP client

The agent's capabilities are also exposed as a **Model Context Protocol (MCP) server** over
stdio, so Claude Desktop, Cursor, or any other agent can drive NaLog directly — the same tool
handlers power both the in-app ReAct loop and MCP (one implementation, two surfaces).

```bash
docker compose run --rm app npm run mcp          # serve MCP over stdio
docker compose run --rm app node scripts/mcp-smoke.js   # verify with a real MCP client
```

Tools exposed (all 9, same as the ReAct loop): `get_farm_overview`, `get_paddy_status`,
`get_sensor_history`, `recall_memory`, `save_memory`, `update_profile`,
`get_irrigation_history`, `analyze_field_photo` (Qwen-VL), `propose_irrigation`
(human-in-the-loop). Implementation: [`src/mcp/server.js`](src/mcp/server.js).

## Tests, benchmark & CI

```bash
npm test       # 103 tests (memory, store, vector, routes, tools, auth, agent loop, streaming, …)
npm run check  # boots app, hits endpoints
npm run bench  # reproducible memory-retrieval benchmark → docs/BENCHMARK.md + chart
```

Tests are fully deterministic (demo mode, no API keys, no external services) and cover:

| Area | Tests |
|---|---|
| **Memory** | 3-tier recall, vector-first hydration, reinforcement, decay, purge + orphan vector cleanup, graceful fallbacks |
| **Memory learning** | Autonomous post-turn extraction (mock LLM), dedup by exact text and semantic similarity, failure handling |
| **Agent loop** | Scripted ReAct rounds: tool execution, chat-tier composition, proposals, event streaming, per-turn usage, cross-session memory |
| **Auth** | API-key gate, Firebase ID-token verification (signature, expiry, audience, issuer, alg-confusion), farmer scoping |
| **Routes** | Health, chat validation, SSE streaming protocol, image validation, alert webhook, proposal ownership + lifecycle |
| **Store / Vector** | Profile CRUD, episodic listing, `getEpisodicByIds`, TTL expiry, upsert/query/delete, filters, persistence |
| **Rerank** | DashScope parsing, disabled/offline/failure fallbacks |
| **Domain** | Crop calendar (rice & sugarcane), demo dataset, NaLog connector, embeddings, tool handlers |

The **memory benchmark** ([docs/BENCHMARK.md](docs/BENCHMARK.md)) shows why the 3-tier
blend exists: on a labeled two-season dataset it reaches **100% Recall@5** and always
ranks the current fact above its outdated twin, while a pure vector search leaks twice as
many stale memories into the context.

CI runs on every push and PR via [GitHub Actions](.github/workflows/ci.yml) on Node 20, 22 and 24 and includes `npm test`, `npm run check` (selfcheck), the MCP client smoke test, and `npm audit`. Node 24 is the active LTS dev/Docker target; Node 20 is kept in the matrix to match Alibaba Function Compute's bundled custom-runtime version.

## Dual-track rationale

This project qualifies for **both** hackathon tracks:

**Track 1 — MemoryAgent** (primary):
- 3-tier memory (profile / episodic / semantic) with explicit relevance scoring,
  **benchmarked** on a labeled dataset ([docs/BENCHMARK.md](docs/BENCHMARK.md))
- Vector-first recall (DashVector candidates → Tablestore point lookups →
  `qwen3-rerank` cross-encoder) — O(topK) regardless of history size
- Soft forgetting via recency decay (120-day half-life) + reinforcement on reuse
- Hard forgetting via Tablestore TTL (~400 days physical deletion)
- Top-K recall within a deliberately limited context window
- Autonomous post-turn learning (cheap `qwen3.6-flash` pass extracts durable facts) with
  **deduplication**: exact text + semantic vector similarity prevents near-duplicate memories
- **Memory lifecycle**: expired memories are purged from both store and vector index;
  orphan vector entries (e.g. from Tablestore TTL) are cleaned lazily during recall
- Cross-session, cross-season memory accumulation

**Track 4 — Autopilot Agent**:
- End-to-end automation of a real business workflow, **with an autonomous trigger**:
  `POST /api/alerts` (sensor threshold breach) → unprompted agronomic reasoning over
  live field data → irrigation proposal → human-in-the-loop approval → LoRaWAN pump
  command to the physical field
- Handles ambiguous inputs (Thai/English, any phrasing, field photos)
- Invokes external tools (NaLog API, ChirpStack, Qwen-VL)
- Human-in-the-loop checkpoints at the critical decision point (pump control), with
  per-farmer ownership enforcement
- **Production-ready and deployed** — not a toy demo

## How this maps to the judging criteria

| Criterion | Where it shows up |
|---|---|
| **Technical Depth & Engineering (30%)** | Deliberate 4-tier Qwen routing (`qwen3.7-max` thinking + tool calls, `qwen3.6-plus` NLG, `qwen3.6-flash` extraction, `qwen3-vl-plus` vision) with hybrid-thinking control and SSE streaming; **MCP server** exposing all 9 tools; a **benchmarked 3-tier decaying memory** (vector-first recall + `qwen3-rerank`, recency decay, reinforcement, Tablestore TTL, dedup, orphan-vector cleanup); verified Firebase identity (RS256 against Google certs, no SDK); 103 automated tests + CI. |
| **Innovation & AI Creativity (30%)** | Autonomous sensor-alert turns with human-in-the-loop actuation; cross-encoder reranking of memories; field-photo grounding via Qwen-VL; modular storage/vector drivers; bounded ReAct loop with graceful degradation; autonomous post-turn learning with semantic dedup; token-budget discipline with concurrency-safe per-turn reporting and retry/backoff. |
| **Problem Value & Impact (25%)** | **Production deployment** serving real farmers (Kut Chum, Yasothon) — water/diesel savings, methane reduction, food security for poor families; open-source (MIT), productizable across co-ops and SE Asia. |
| **Presentation & Documentation (15%)** | Architecture diagram, live streaming UI with tool-trace transparency, reproducible benchmark with chart ([docs/BENCHMARK.md](docs/BENCHMARK.md)), full docs (`README`, `docs/ARCHITECTURE.md`, `docs/proof-of-alibaba-deployment.md`), [blog post](https://albertoroura.com/adding-qwen-powered-memory-augmented-agent-to-nalog-platform/). |

## Project layout

```
src/
  llm/          Qwen client (Model Studio): chat/stream/JSON, embeddings, qwen3-rerank
  memory/       3-tier memory: store (local|Tablestore) + vector (local|DashVector)
  agent/        ReAct loop (streaming events), tools (incl. Qwen-VL photo), prompts
  integrations/ NaLog read connector, ChirpStack downlink, crop calendar, demo data
  routes/       chat (SSE), proposals (HITL, ownership), alerts (autonomous), health
  middleware/   API-key gate + verified Firebase farmer identity
  mcp/          MCP server exposing the agent tools over stdio
public/         web chat UI (streaming, tool trace, photo upload, memory panel)
deploy/         Tablestore/DashVector provisioning, Function Compute deploy
scripts/        selfcheck, MCP smoke, deployment smoke, memory benchmark, demo seed
test/           103 automated tests (all deterministic, no cloud dependencies)
docs/           architecture, Alibaba proof, benchmark, submission checklist
```

## License

MIT — see [LICENSE](LICENSE). Open source so any farmer co-op, NGO, or developer can run it.
