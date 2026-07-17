import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import LocalStore from '../src/memory/store/localStore.js';
import LocalVector from '../src/memory/vector/localVector.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { AgentService } from '../src/agent/agent.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-agent-'));
}

async function makeAgent(script) {
  const dir = tmp();
  const store = await new LocalStore(dir).init();
  const memory = new MemoryManager(store, await new LocalVector(dir).init());
  // Scripted Qwen: pops one response per call; accounts fake usage.
  let call = 0;
  const chatFn = async ({ usage, onDelta, stream }) => {
    const step = script[Math.min(call, script.length - 1)];
    call += 1;
    if (usage) {
      usage.total += 100;
      usage.calls += 1;
    }
    if (stream && onDelta && step.content) onDelta({ content: step.content });
    return { role: 'assistant', content: step.content || '', tool_calls: step.tool_calls };
  };
  // Disable the background learning LLM call.
  memory.learnFromConversation = async () => ({ profileFacts: [], episodic: [] });
  return { agent: new AgentService(memory, store, { chatFn }), store, memory };
}

const toolCall = (name, args) => ({
  id: `call-${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

test('ReAct loop: tool round then chat-tier composition', async () => {
  const { agent } = await makeAgent([
    { tool_calls: [toolCall('get_paddy_status', { paddyId: 'paddy-rice-3' })] },
    { content: 'draft from reason tier' },
    { content: 'สวัสดีครับ! Paddy 3 is at -12cm.' },
  ]);
  const result = await agent.run({ farmerId: 'f1', userText: 'สถานะนา 3?' });

  assert.equal(result.toolTrace.length, 1);
  assert.equal(result.toolTrace[0].tool, 'get_paddy_status');
  assert.ok(result.toolTrace[0].result.paddy, 'tool actually hit the demo connector');
  assert.equal(result.message, 'สวัสดีครับ! Paddy 3 is at -12cm.');
  assert.equal(result.usage.turnTokens, 300, 'per-turn usage from all three LLM calls');
  assert.equal(result.usage.llmCalls, 3);
});

test('direct reply without tools skips the compose phase', async () => {
  const { agent } = await makeAgent([{ content: 'Just a greeting.' }]);
  const result = await agent.run({ farmerId: 'f1', userText: 'hello' });
  assert.equal(result.message, 'Just a greeting.');
  assert.equal(result.toolTrace.length, 0);
  assert.equal(result.usage.llmCalls, 1);
});

test('propose_irrigation creates a pending proposal and emits events', async () => {
  const { agent, store } = await makeAgent([
    { tool_calls: [toolCall('propose_irrigation', { paddyId: 'paddy-rice-3', action: 'on', reason: 'level below trigger' })] },
    { content: 'draft' },
    { content: 'I prepared a pump proposal for your approval.' },
  ]);
  const events = [];
  const result = await agent.run({
    farmerId: 'f1',
    userText: 'should I pump?',
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].status, 'pending');
  const stored = await store.getProposal(result.proposals[0].proposalId);
  assert.equal(stored.farmerId, 'f1');

  const types = events.map((e) => e.type);
  assert.ok(types.includes('session'));
  assert.ok(types.includes('tool'));
  assert.ok(types.includes('tool_result'));
  assert.ok(types.includes('proposal'));
  assert.ok(types.includes('delta'), 'final reply must stream as delta events');
});

test('memories injected into context are reinforced after the turn', async () => {
  const { agent, memory } = await makeAgent([{ content: 'ok' }]);
  await memory.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'paddy drains fast in dry season' });

  const result = await agent.run({ farmerId: 'f1', userText: 'how fast does my paddy drain?' });
  assert.equal(result.memoryUsed.length, 1);

  const [m] = await memory.recall({ farmerId: 'f1', query: '', limit: 1 });
  assert.ok(m.reinforcement >= 1, 'context-injected memory must be reinforced on use');
});

test('cross-session memory: second session knows what the first learned', async () => {
  const { agent, memory } = await makeAgent([{ content: 'noted' }]);
  await memory.recordEpisodic({ farmerId: 'f1', paddyId: 'p1', type: 'outcome', text: 'AWD cut pumping 31% with no yield loss' });

  const s1 = await agent.run({ farmerId: 'f1', userText: 'what did AWD save last season?' });
  const s2 = await agent.run({ farmerId: 'f1', userText: 'what did AWD save last season?', sessionId: undefined });
  assert.notEqual(s1.sessionId, s2.sessionId, 'separate sessions');
  assert.ok(s2.memoryUsed.some((m) => m.text.includes('31%')), 'memory crossed sessions');
});

test('memory_trace event is emitted with recall metadata', async () => {
  const { agent, memory } = await makeAgent([{ content: 'ok' }]);
  await memory.recordEpisodic({ farmerId: 'f1', type: 'observation', text: 'paddy drains fast' });

  const events = [];
  await agent.run({ farmerId: 'f1', userText: 'drainage', onEvent: (e) => events.push(e) });

  const traceEvent = events.find((e) => e.type === 'memory_trace');
  assert.ok(traceEvent, 'memory_trace event emitted');
  assert.equal(traceEvent.source, 'context');
  assert.ok(traceEvent.candidatesConsidered >= 1);
  assert.ok(Array.isArray(traceEvent.memories));
  assert.ok(traceEvent.memories[0].memoryId);
  assert.ok(typeof traceEvent.memories[0].score === 'number');
});

test('memory_diff event is emitted after learning produces changes', async () => {
  const dir = tmp();
  const store = await new LocalStore(dir).init();
  const memory = new MemoryManager(store, await new LocalVector(dir).init());

  let call = 0;
  const chatFn = async ({ usage, onDelta, stream }) => {
    call += 1;
    if (usage) { usage.total += 100; usage.calls += 1; }
    return { role: 'assistant', content: 'ok', tool_calls: undefined };
  };
  // Real learning — returns diff
  memory.learnFromConversation = async () => ({
    profileFacts: [{ key: 'lang', value: 'th' }],
    episodic: [{ memoryId: 'm1', text: 'new fact' }],
    diff: { newMemories: 1, reinforced: 0, superseded: 0, profileUpdates: 1 },
  });
  const agent = new AgentService(memory, store, { chatFn });

  const events = [];
  await agent.run({ farmerId: 'f1', userText: 'hello', onEvent: (e) => events.push(e) });

  // Learning is async — give it a tick
  await new Promise((r) => setTimeout(r, 50));

  const diffEvent = events.find((e) => e.type === 'memory_diff');
  assert.ok(diffEvent, 'memory_diff event emitted');
  assert.equal(diffEvent.newMemories, 1);
  assert.equal(diffEvent.profileUpdates, 1);
});

test('unknown tools and handler failures degrade gracefully', async () => {
  const { agent } = await makeAgent([
    { tool_calls: [toolCall('does_not_exist', {})] },
    { content: 'draft' },
    { content: 'recovered' },
  ]);
  const result = await agent.run({ farmerId: 'f1', userText: 'x' });
  assert.equal(result.toolTrace[0].result.error, 'Unknown tool does_not_exist');
  assert.equal(result.message, 'recovered');
});
