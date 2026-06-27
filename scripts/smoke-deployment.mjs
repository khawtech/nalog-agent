// ──────────────────────────────────────────────────────────────────────────
// Live deployment smoke test for the NaLog Agent on Function Compute.
//
// Exercises the real, deployed endpoints over HTTPS to verify the full stack:
// FC custom runtime → Qwen → Tablestore → DashVector → live NaLog AWS API.
//
// Usage:
//   AGENT_API_KEY=... node scripts/smoke-deployment.mjs
//   NALOG_TEST_TOKEN=<firebase-jwt> node scripts/smoke-deployment.mjs
//
// Exit code 0 = all required checks passed; non-zero = at least one failed.
// ──────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { getTestFirebaseToken } from './firebase-test-token.mjs';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const API_KEY = process.env.AGENT_API_KEY || '';
const DEMO_FARMER_ID = process.env.DEMO_FARMER_ID || 'demo-farmer';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000);

let passed = 0;
let failed = 0;
let nalogToken = null;

function record(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (API_KEY) h['x-api-key'] = API_KEY;
  if (nalogToken) h['X-NaLog-Token'] = nalogToken;
  return h;
}

async function http(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

const UNIQUE = DEMO_FARMER_ID;

async function main() {
  console.log(`NaLog Agent — live deployment smoke test`);
  console.log(`Target: ${BASE_URL}\n`);

  try {
    nalogToken = await getTestFirebaseToken(DEMO_FARMER_ID);
    record('Firebase test token', Boolean(nalogToken), nalogToken ? 'minted' : 'unavailable — live NaLog checks skipped');
  } catch (e) {
    record('Firebase test token', false, e.message);
  }

  try {
    const { status, json } = await http('GET', '/healthz');
    const ok = status === 200 && json?.status === 'ok';
    record('GET /healthz', ok, ok ? `nalog=${json.nalogMode} storage=${json.storage}` : `HTTP ${status}`);
    record('nalogMode is live', json?.nalogMode === 'live', json?.nalogMode);
    record('storage driver is alibaba (Tablestore)', json?.storage === 'alibaba', json?.storage);
    record('vector driver is dashvector', json?.vector === 'dashvector', json?.vector);
  } catch (e) {
    record('GET /healthz', false, e.message);
  }

  try {
    const res = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    record('GET / (web UI)', res.ok, `HTTP ${res.status}`);
  } catch (e) {
    record('GET / (web UI)', false, e.message);
  }

  let sessionId = null;
  let paddy3Id = null;

  if (nalogToken) {
    try {
      const { status, json } = await http('POST', '/api/chat', {
        message: 'List my farms and paddies briefly.',
        farmerId: UNIQUE,
      });
      const farmsListed =
        status === 200 &&
        (json?.message?.includes('Kutchum') ||
          JSON.stringify(json?.toolTrace || []).includes('Kutchum'));
      record('POST /api/chat (live farm overview)', farmsListed, okDetail(status, json));
      sessionId = json?.sessionId || null;
    } catch (e) {
      record('POST /api/chat (live farm overview)', false, e.message);
    }

    try {
      const { status, json } = await http('POST', '/api/chat', {
        message: 'What is the water level in Paddy 3 (North Rice) and should I pump now?',
        farmerId: UNIQUE,
        sessionId,
      });
      const ok = status === 200 && typeof json?.message === 'string' && json.message.length > 0;
      record('POST /api/chat (Paddy 3 AWD turn)', ok, okDetail(status, json));
      sessionId = json?.sessionId || sessionId;
      const usedPaddyTool = (json?.toolTrace || []).some((t) => t.tool === 'get_paddy_status');
      record('agent called get_paddy_status', usedPaddyTool);
      const trace = JSON.stringify(json?.toolTrace || []);
      const sawLevel = trace.includes('"level"') || trace.includes('North Rice');
      record('grounded in live sensor/paddy data', sawLevel);
      const match = trace.match(/"paddyId":"([^"]+)"/);
      if (match) paddy3Id = match[1];
    } catch (e) {
      record('POST /api/chat (Paddy 3 AWD turn)', false, e.message);
    }
  } else {
    record('live NaLog integration', false, 'no Firebase token');
  }

  if (sessionId) {
    try {
      const { status, json } = await http('GET', `/api/session/${sessionId}/messages`);
      record('GET /api/session/:id/messages', status === 200 && (json?.messages?.length || 0) >= 2, `${json?.messages?.length || 0} msgs`);
    } catch (e) {
      record('GET /api/session/:id/messages', false, e.message);
    }
  }

  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'ping', farmerId: UNIQUE }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    record('auth gate rejects missing API key', API_KEY ? res.status === 401 : res.status !== 401, `HTTP ${res.status}`);
  } catch (e) {
    record('auth gate check', false, e.message);
  }

  try {
    const origin = 'https://nalog-app.khawtech.com';
    const res = await fetch(`${BASE_URL}/healthz`, {
      headers: { Origin: origin },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corsOk = res.headers.get('access-control-allow-origin') === origin;
    record('CORS allows NaLog frontend origin', corsOk, res.headers.get('access-control-allow-origin') || 'none');
  } catch (e) {
    record('CORS allows NaLog frontend origin', false, e.message);
  }

  try {
    const { status } = await http('POST', '/api/chat', { message: '', farmerId: UNIQUE });
    record('POST /api/chat rejects empty message', status === 400, `HTTP ${status}`);
  } catch (e) {
    record('POST /api/chat rejects empty message', false, e.message);
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

function okDetail(status, json) {
  if (status === 200 && json?.usage?.turnTokens) return `${json.usage.turnTokens} tokens`;
  return `HTTP ${status} ${json?.error || ''}`;
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
