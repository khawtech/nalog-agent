// Boots the app in-process and exercises the core endpoints without external
// dependencies. Validates wiring (storage, routes, memory, NaLog demo connector).
// A live Qwen call is only attempted if DASHSCOPE_API_KEY is set.
// Usage: npm run check
import { buildApp } from '../src/server.js';
import { AgentService } from '../src/agent/agent.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { getStore } from '../src/memory/store/index.js';
import config from '../src/config.js';

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const fail = (name, detail) => {
  failures++;
  console.error(`  ✗ ${name} — ${detail}`);
};

async function main() {
  const store = await getStore();
  const memory = await MemoryManager.create();
  const agent = new AgentService(memory, store);
  const app = buildApp({ agent, memory, store });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('Self-check: nalog-agent\n');

  // 1. health
  try {
    const h = await (await fetch(`${base}/healthz`)).json();
    h.status === 'ok' ? ok('GET /healthz') : fail('GET /healthz', JSON.stringify(h));
  } catch (e) {
    fail('GET /healthz', e.message);
  }

  // 2. NaLog demo connector composes a paddy status
  try {
    const nalog = await import('../src/integrations/nalog.js');
    const status = await nalog.getPaddyStatus('paddy-rice-3');
    status?.sensors?.length ? ok('NaLog getPaddyStatus(paddy-rice-3)') : fail('NaLog getPaddyStatus', 'no sensors');
  } catch (e) {
    fail('NaLog getPaddyStatus', e.message);
  }

  // 3. memory round-trip
  try {
    await memory.recordEpisodic({ farmerId: 'selfcheck', paddyId: 'p1', type: 'observation', text: 'selfcheck memory' });
    const recalled = await memory.recall({ farmerId: 'selfcheck', query: 'selfcheck', limit: 3 });
    recalled.length ? ok('memory record + recall') : fail('memory record + recall', 'nothing recalled');
  } catch (e) {
    fail('memory record + recall', e.message);
  }

  // 4. memory endpoint
  try {
    const m = await (await fetch(`${base}/api/memory?farmerId=selfcheck`)).json();
    m.farmerId === 'selfcheck' ? ok('GET /api/memory') : fail('GET /api/memory', JSON.stringify(m));
  } catch (e) {
    fail('GET /api/memory', e.message);
  }

  // 5. full chat turn (only with a real key)
  if (config.dashscope.apiKey && config.dashscope.apiKey !== 'sk-replace-me') {
    try {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'What is the water level in Paddy 3 and should I pump?' }),
      });
      const data = await res.json();
      data.message ? ok(`POST /api/chat (Qwen) — ${data.usage?.turnTokens} tokens`) : fail('POST /api/chat', JSON.stringify(data));
    } catch (e) {
      fail('POST /api/chat', e.message);
    }
  } else {
    console.log('  • POST /api/chat skipped (set DASHSCOPE_API_KEY to test the live Qwen loop)');
  }

  server.close();
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('self-check crashed:', err);
  process.exit(1);
});
