# Security model

NaLog Agent controls real irrigation pumps via LoRaWAN downlinks. A hallucinated
"turn on" command can flood a paddy, waste diesel, or damage a crop in flowering
stage. Security isn't bolted on — it shapes the architecture.

## Identity & access control

### Firebase JWT (RS256) verification

Farmer identity comes from a Firebase ID token passed in `X-NaLog-Token`. The
backend verifies it **from first principles** — no Firebase Admin SDK:

1. Decode the JWT header, extract `kid`.
2. Fetch Google's rotating X.509 public certificates (`googleapis.com/…/certificates`),
   cached until `max-age` expires.
3. Parse the X.509 cert for the matching `kid` into an RSA public key.
4. Verify the signature with `crypto.createVerify('RSA-SHA256')`.
5. Validate `iss`, `aud` (must match `FIREBASE_PROJECT_ID`), `exp`, `iat`, and
   reject any `alg` that isn't `RS256` (algorithm-confusion defense).

Implementation: [`src/utils/jwt.js`](../src/utils/jwt.js).
Tests: 7 cases including tampering, expiry, wrong audience/issuer, and `alg: 'none'`
rejection ([`test/jwt.test.js`](../test/jwt.test.js)).

### API key gate (constant-time comparison)

The shared-secret `AGENT_API_KEY` gate uses `crypto.timingSafeEqual` to prevent
timing side-channels. When the key is unset, the gate is a no-op (local demo mode).

Implementation: [`src/middleware/auth.js`](../src/middleware/auth.js).

### Farmer scoping

Every memory, session, and proposal is scoped to the authenticated `farmerId`.
The chat route **ignores** any `farmerId` sent in the request body — identity is
derived exclusively from the verified token. Session history returns 403 if the
session belongs to a different farmer.

## Input validation

### MCP tool inputs (Zod)

All 9 MCP tool inputs are validated with Zod schemas — `z.string()`, `z.enum()`,
`z.number().min().max()`, `z.string().url()` — before any handler runs.

Implementation: [`src/mcp/server.js`](../src/mcp/server.js).

### HTTP route validation

- Chat: message required, max 4000 chars, image format/size validated before
  forwarding to Qwen-VL.
- Alerts: `paddyId` must be a string; webhook is token-gated in production.
- Body size: Express JSON parser capped at 8 MB.

## LLM output guardrails

### Grounding: never invent water levels

The system prompt contains hard rules:

> *"Always call `get_paddy_status` / `get_sensor_history` before advising.
> Never invent water levels, pump states, or sensor readings."*

The compose step (chat-tier prompt) reinforces: *"Ground your reply in the actual
numbers from the tool results."* An anti-hallucination guard in the ReAct loop
forbids claiming a proposal was prepared unless `propose_irrigation` actually ran.

Implementation: [`src/agent/prompts.js`](../src/agent/prompts.js) (rules),
[`src/agent/agent.js`](../src/agent/agent.js) (compose + anti-hallucination).

### Proposal-only actuation

The LLM **cannot** directly control a pump. It can only call `propose_irrigation`,
which creates a `status: 'pending'` record. The LoRaWAN downlink is sent **only**
when the farmer taps "Approve" in the UI, triggering `POST /api/proposals/:id/approve`
with ownership verification.

`REQUIRE_HUMAN_APPROVAL=true` is the default. Even if misconfigured, the tool
handler never calls ChirpStack — only the approval route does.

Implementation: [`src/agent/tools.js`](../src/agent/tools.js) (tool handler),
[`src/routes/proposals.js`](../src/routes/proposals.js) (approval + downlink).

## Memory injection prevention

### Embedding similarity gates

Memory writes go through a 3-tier dedup pipeline before anything is persisted:

1. **Exact text match** — rejects verbatim duplicates.
2. **Semantic near-duplicate** (cosine ≥ 0.85) — rejects paraphrases of existing
   memories.
3. **Contradiction adjudication** (cosine 0.50–0.85) — a cheap `qwen3.6-flash`
   call determines whether a new fact supersedes, corrects, or contradicts an
   existing one. If yes, the old memory is marked `supersededBy` and excluded from
   recall — but kept in storage for auditability.

### Cross-farmer isolation

Vector recall is filtered by `farmerId` at the DashVector query level. A farmer
can never see or influence another farmer's memories.

### Superseded memory exclusion

`MemoryManager.recall()` explicitly filters out any memory where `supersededBy`
is set, preventing stale or manipulated facts from entering the context window.

Implementation: [`src/memory/memoryManager.js`](../src/memory/memoryManager.js).

## Token budget discipline

| Control | Value | Where |
|---------|-------|-------|
| `MAX_TOKENS_PER_TURN` | 6000 (configurable) | Passed to DashScope `max_tokens` |
| `MAX_TOOL_ROUNDS` | 6 | Bounds the ReAct tool loop |
| 4-tier model routing | `qwen3.7-max` (thinking), `qwen3.6-plus` (NLG), `qwen3.6-flash` (extraction), `qwen3-vl-plus` (vision) | Cheap models for cheap tasks |
| Per-turn accounting | Concurrency-safe `newUsageCollector()` tracks input/output/total tokens per turn | Reported in every API response |

Implementation: [`src/llm/dashscope.js`](../src/llm/dashscope.js),
[`src/agent/agent.js`](../src/agent/agent.js).

## Rate limiting

- **Upstream**: custom retry with exponential backoff on DashScope 429/5xx
  (OpenAI SDK auto-retries disabled).
- **Body size**: Express JSON parser capped at 8 MB.
- **Message length**: 4000-char cap on chat input.
- **Gateway**: Alibaba Function Compute HTTP triggers support WAF and throttle
  rules at the API Gateway layer; the app relies on this + the API key gate
  for production rate control.

## Other hardening

| Measure | Detail |
|---------|--------|
| CORS allow-list | `ALLOWED_ORIGINS` env var; no wildcard `*` in production |
| `x-powered-by` disabled | Reduces server fingerprinting |
| Secret redaction | Logger strips `authorization`, `apiKey`, `token` fields before writing |
| Memory TTL | Tablestore rows expire after ~400 days; orphan vectors cleaned lazily during recall |
| Graceful degradation | Rerank offline → falls back to blend score; vector service down → still serves profile + session context |
