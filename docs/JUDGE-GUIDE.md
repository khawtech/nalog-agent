# Judge Quick Start — 2 minutes

> **Track 1 — MemoryAgent** | Production system serving real Thai rice farmers

## 30-second overview

NaLog Agent is a **Qwen-powered agronomist with persistent, evolving memory** for
smallholder farmers. It reads IoT sensor data, accumulates field experience across
seasons, detects and supersedes contradictions, forgets outdated knowledge, and
proposes irrigation actions — with human approval before any pump command.

**Not a hackathon prototype** — the same codebase runs on Alibaba Cloud Function
Compute in Bangkok, serving real farmers in Isan, Thailand.

## Try it locally (< 2 minutes)

```bash
cp .env.example .env          # add your DASHSCOPE_API_KEY
docker compose build
docker compose run --rm app npm run seed
docker compose up              # → http://localhost:8080
```

Ask: *"What's the water level in Paddy 3 and what do you recommend?"*

Watch the SSE stream: thinking → live tool calls → reply → **memory trace** → **memory diff**.

## What to look for

| Track 1 requirement | Where to see it |
|---|---|
| **Persistent memory** | Ask the same question in a new session — it remembers |
| **Accumulates experience** | `memory_diff` SSE event after each turn: "2 new, 1 reinforced" |
| **Supersedes contradictions** | [`docs/BENCHMARK.md`](BENCHMARK.md) — LLM adjudication, 0 stale facts served |
| **Timely forgetting** | Recency decay (120-day half-life) + Tablestore TTL (~400 days) |
| **Recall in limited context** | Vector-first top-K + `qwen3-rerank` + keyword + blend → 100% Recall@5 |

## Key differentiators vs competitors

1. **4-tier hybrid recall** — semantic vectors + BM25 keyword + recency decay + reinforcement, benchmarked with ablation
2. **LLM-adjudicated supersession** — contradictions detected, old facts marked (not deleted) for auditability
3. **Safety rescue floor** — critical memories (reinforcement ≥ 5) always surface
4. **Production on 6 Alibaba Cloud services** — FC, Tablestore, DashVector, Model Studio (4 tiers), embeddings, rerank
5. **9 MCP tools** over official `@modelcontextprotocol/sdk`
6. **Human-in-the-loop actuation** — proposals, not direct pump commands
7. **125 automated tests**, CI on Node 20/22/24, reproducible benchmark

## Architecture

![Architecture](arch.png)

**Request flow:** Auth → Vision (optional) → Memory context → ReAct loop (`qwen3.7-max`, 6 tool rounds) → Reply (`qwen3.6-plus`) → SSE stream → Persist + Learn (`qwen3.6-flash`) → Purge expired

## Benchmark at a glance

| Strategy | Recall@5 | Stale@5 |
|---|---|---|
| append-only (Mem0-style) | 92.9% | 10 |
| **4-tier + supersession (production)** | **100.0%** | **0** |

Full ablation: [`docs/BENCHMARK.md`](BENCHMARK.md)

## File map for code review

| What | File |
|---|---|
| Memory system | [`src/memory/memoryManager.js`](../src/memory/memoryManager.js) |
| ReAct agent loop | [`src/agent/agent.js`](../src/agent/agent.js) |
| 9 tool handlers | [`src/agent/tools.js`](../src/agent/tools.js) |
| Qwen client (4-tier routing) | [`src/llm/dashscope.js`](../src/llm/dashscope.js) |
| MCP server | [`src/mcp/server.js`](../src/mcp/server.js) |
| Alibaba proof | [`docs/proof-of-alibaba-deployment.md`](proof-of-alibaba-deployment.md) |
| Tests (125) | [`test/`](../test/) |
| Benchmark | [`scripts/benchmark-memory.mjs`](../scripts/benchmark-memory.mjs) |
