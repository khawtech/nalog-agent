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
(dual-track: the 3-tier decaying memory system fulfils Track 1, while the end-to-end
automation from sensor alert → agronomic reasoning → human-in-the-loop pump approval
→ LoRaWAN downlink to the field satisfies Track 4's production workflow criteria.
See [Dual-track rationale](#dual-track-rationale) below.)

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
  Tablestore TTL unless they keep proving useful (reinforcement).
- **Recalls within a tiny context window** — top-K semantic recall + summarisation, so it
  works for offline-first, low-bandwidth rural deployments.
- **Never acts blindly** — any pump action is a *proposal* a human approves; only then is a
  LoRaWAN downlink sent.
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
| **Model Studio (Qwen)** | All reasoning + Thai/English NLG, tool use | [`client init`](src/llm/dashscope.js#L17-L20), [`chat()`](src/llm/dashscope.js#L51-L90), [`chatJSON()`](src/llm/dashscope.js#L96-L116) |
| **Model Studio (embeddings)** | Semantic memory vectors (`text-embedding-v3`) | [`embed()`](src/llm/embeddings.js#L24-L29) |
| **Tablestore** | Persistent memory (profile, episodic w/ TTL, sessions, proposals) | [`tablestoreStore.js`](src/memory/store/tablestoreStore.js), [`provisionTables()`](src/memory/store/tablestoreStore.js#L287-L318) |
| **DashVector** | Semantic recall of past field experience | [`dashVector.js`](src/memory/vector/dashVector.js) |
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

The bundled web chat UI (`public/`) gives you a chat panel with Thai/English suggestions,
an approval card for pump proposals, and a memory panel showing what the agent remembers.

Try asking (Thai or English):
- *"นาแปลง 3 ตอนนี้ต้องสูบน้ำไหม?"* ("Does Paddy 3 need pumping now?")
- *"What's the water level in Paddy 3 and what do you recommend?"*

The agent reads the (demo) sensor trend, recalls past experience, and — if a pump action
makes sense — shows an **approval card**. Approving it sends the LoRaWAN downlink (simulated
unless `CHIRPSTACK_*` is configured).

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

In production, the KhawTECH NaLog farmer web app connects to this backend via the
Function Compute HTTP trigger, forwarding the farmer's Firebase ID token for identity
scoping.

Full steps: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`deploy/fc-zip-build.sh`](deploy/fc-zip-build.sh)
and [`deploy/fc-deploy.mjs`](deploy/fc-deploy.mjs).

## Use it from any MCP client

The agent's capabilities are also exposed as a **Model Context Protocol (MCP) server** over
stdio, so Claude Desktop, Cursor, or any other agent can drive NaLog directly — the same tool
handlers power both the in-app ReAct loop and MCP (one implementation, two surfaces).

```bash
docker compose run --rm app npm run mcp          # serve MCP over stdio
docker compose run --rm app node scripts/mcp-smoke.js   # verify with a real MCP client
```

Tools exposed: `get_farm_overview`, `get_paddy_status`, `get_sensor_history`, `recall_memory`,
`save_memory`, `propose_irrigation` (human-in-the-loop). Implementation:
[`src/mcp/server.js`](src/mcp/server.js).

## Tests & CI

```bash
npm test       # 64 tests (memory, store, vector, routes, tools, embeddings, crop calendar, demo data)
npm run check  # boots app, hits endpoints
```

Tests run in demo mode (no API keys, no external services needed) and cover:

| Area | Tests |
|---|---|
| **Memory** | 3-tier recall, reinforcement, profile, context building, decay |
| **Store** | Profile CRUD, episodic listing, TTL expiry, proposal lifecycle |
| **Vector** | Upsert/query/delete, filter, persistence, cosine ranking |
| **Embeddings** | Cosine similarity, pseudo-embedding determinism, semantic ranking |
| **Crop calendar** | Rice & sugarcane stages, irrigation recommendations |
| **Demo data** | Dataset shape, sensor history generation, AWD drain trend |
| **NaLog connector** | Demo-mode API, paddy status aggregation, sensor history |
| **Routes** | Health endpoint, chat validation, proposal approve/reject lifecycle |
| **Tools** | All 8 tool handlers, schema validation, round-trip memory |

CI runs on every push and PR via [GitHub Actions](.github/workflows/ci.yml) on Node 20 and 22.

## Dual-track rationale

This project qualifies for **both** hackathon tracks:

**Track 1 — MemoryAgent** (primary):
- 3-tier memory (profile / episodic / semantic) with explicit relevance scoring
- Soft forgetting via recency decay (120-day half-life) + reinforcement on reuse
- Hard forgetting via Tablestore TTL (~400 days physical deletion)
- Top-K recall within a deliberately limited context window
- Autonomous post-turn learning (cheap `qwen-turbo` pass extracts durable facts)
- Cross-session, cross-season memory accumulation

**Track 4 — Autopilot Agent**:
- End-to-end automation of a real business workflow: sensor alert → agronomic
  reasoning → irrigation proposal → human-in-the-loop approval → LoRaWAN pump
  command to the physical field
- Handles ambiguous inputs (Thai/English, any phrasing)
- Invokes external tools (NaLog API, ChirpStack)
- Human-in-the-loop checkpoints at the critical decision point (pump control)
- **Production-ready and deployed** — not a toy demo

## How this maps to the judging criteria

| Criterion | Where it shows up |
|---|---|
| **Technical Depth & Engineering (30%)** | Sophisticated Qwen use (model tiering turbo/plus/max, tool-calling, embeddings); **MCP server** exposing custom skills; a novel **3-tier decaying memory** (soft recency decay + reinforcement + hard Tablestore TTL) with rank-based, metric-agnostic semantic recall; 64 automated tests + CI. |
| **Innovation & AI Creativity (30%)** | Modular, swappable storage/vector drivers; bounded ReAct loop with graceful degradation; Express 5 service; autonomous post-turn learning; token-budget discipline with per-turn reporting. |
| **Problem Value & Impact (25%)** | **Production deployment** serving real farmers (Kut Chum, Yasothon) — water/diesel savings, methane reduction, food security for poor families; open-source (MIT), productizable across co-ops and SE Asia. |
| **Presentation & Documentation (15%)** | Architecture diagram (Mermaid), per-turn token + recalled-memory visualisation in the UI, full docs (`README`, `docs/ARCHITECTURE.md`, `docs/proof-of-alibaba-deployment.md`), [blog post](https://albertoroura.com/adding-qwen-powered-memory-augmented-agent-to-nalog-platform/). |

## Project layout

```
src/
  llm/          Qwen client (Model Studio) + embeddings
  memory/       3-tier memory: store (local|Tablestore) + vector (local|DashVector)
  agent/        ReAct loop, tools, prompts
  integrations/ NaLog read connector, ChirpStack downlink, crop calendar, demo data
  routes/       chat, proposals (HITL), health
  mcp/          MCP server exposing the agent tools over stdio
public/         web chat UI (chat panel + memory panel + proposal approval cards)
deploy/         Tablestore/DashVector provisioning, Function Compute deploy
test/           64 automated tests (memory, store, vector, routes, tools, embeddings)
docs/           architecture, Alibaba proof, submission checklist
```

## License

MIT — see [LICENSE](LICENSE). Open source so any farmer co-op, NGO, or developer can run it.
