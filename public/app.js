const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const formEl = $('#chat-form');
const inputEl = $('#chat-input');
const sendBtn = $('#send-btn');
const photoBtn = $('#photo-btn');
const photoInput = $('#photo-input');

let sessionId = localStorage.getItem('nalog-agent-session') || null;
let attachedImage = null; // data URL

// Optional credentials for protected deployments, passed once via URL params
// and kept in localStorage: ?key=<AGENT_API_KEY> and, for live (non-demo)
// deployments, ?token=<Firebase ID token> to identify the farmer.
(function initCredentials() {
  const params = new URLSearchParams(location.search);
  const key = params.get('key');
  const token = params.get('token');
  if (key) localStorage.setItem('nalog-agent-key', key);
  if (token) localStorage.setItem('nalog-agent-token', token);
  if (key || token) {
    params.delete('key');
    params.delete('token');
    history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
  }
})();

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  const key = localStorage.getItem('nalog-agent-key');
  if (key) headers['x-api-key'] = key;
  const token = localStorage.getItem('nalog-agent-token');
  if (token) headers['X-NaLog-Token'] = token;
  return headers;
}

init();

async function init() {
  await loadHealth();
  await loadMemory();
  addSystem('Welcome to the NaLog Agent — your AWD irrigation assistant. Ask about a paddy (Thai or English), or attach a field photo 📷.');

  formEl.addEventListener('submit', onSubmit);
  $('#refresh-memory').addEventListener('click', loadMemory);
  document.querySelectorAll('.suggestions button').forEach((b) =>
    b.addEventListener('click', () => {
      inputEl.value = b.dataset.q;
      formEl.requestSubmit();
    })
  );
  photoBtn.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', onPhotoPicked);
}

async function loadHealth() {
  try {
    const h = await (await fetch('/healthz')).json();
    $('#mode-badge').textContent = `NaLog: ${h.nalogMode}`;
    $('#storage-badge').textContent = `${h.storage} · ${h.vector}`;
  } catch {
    $('#mode-badge').textContent = 'offline';
  }
}

function onPhotoPicked() {
  const file = photoInput.files?.[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    addSystem('⚠️ Photo too large (max 4MB).');
    photoInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    attachedImage = reader.result;
    photoBtn.classList.add('has-photo');
    photoBtn.title = 'Photo attached — will be analyzed by Qwen-VL';
  };
  reader.readAsDataURL(file);
}

async function onSubmit(e) {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text && !attachedImage) return;
  inputEl.value = '';
  addMessage('user', text || '(field photo)', null, attachedImage);
  const image = attachedImage;
  attachedImage = null;
  photoBtn.classList.remove('has-photo');
  photoInput.value = '';

  setBusy(true);
  try {
    await streamChat(text, image);
    await loadMemory();
  } catch (err) {
    addSystem(`⚠️ ${err.message}`);
  } finally {
    setBusy(false);
    inputEl.focus();
  }
}

// ── SSE streaming chat ──────────────────────────────────────────────────────
async function streamChat(text, image) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    body: JSON.stringify({ sessionId, message: text, image: image || undefined, stream: true }),
  });
  if (res.status === 401) {
    addSystem('🔒 This deployment requires credentials. Re-open the page with ?key=YOUR_AGENT_API_KEY (live mode also needs &token=FIREBASE_ID_TOKEN).');
    return;
  }
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `request failed (${res.status})`);
  }

  const live = createLiveMessage();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalData = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = /event: (.+)/.exec(block)?.[1];
      const dataRaw = /data: (.+)/.exec(block)?.[1];
      if (!event || !dataRaw) continue;
      const data = JSON.parse(dataRaw);
      handleEvent(live, event, data, (d) => (finalData = d));
    }
  }

  live.finish(finalData);
  if (finalData) {
    sessionId = finalData.sessionId;
    localStorage.setItem('nalog-agent-session', sessionId);
    (finalData.proposals || []).forEach((p) => renderProposal(p));
  }
}

function handleEvent(live, event, data, setFinal) {
  switch (event) {
    case 'session':
      break;
    case 'photo':
      live.setStatus('📷 Photo analyzed by Qwen-VL');
      break;
    case 'thinking':
      live.think(data.text);
      break;
    case 'tool':
      live.tool(`→ ${data.tool}(${shortArgs(data.args)})`);
      break;
    case 'tool_result':
      live.toolDone(data.ok);
      break;
    case 'proposal':
      break; // rendered from the final payload
    case 'delta':
      live.append(data.text);
      break;
    case 'memory_trace':
      live.memoryTrace(data);
      break;
    case 'memory_diff':
      renderMemoryDiff(data);
      break;
    case 'final':
      setFinal(data);
      break;
    case 'error':
      live.append(`⚠️ ${data.error}`);
      break;
  }
}

function shortArgs(args) {
  const s = JSON.stringify(args || {});
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

// A live assistant bubble: status line (thinking / tools) + streaming text.
function createLiveMessage() {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  const status = document.createElement('div');
  status.className = 'live-status';
  status.textContent = '🧠 thinking…';
  const body = document.createElement('div');
  body.className = 'live-body';
  el.appendChild(status);
  el.appendChild(body);
  messagesEl.appendChild(el);
  scroll();

  const traceLines = [];
  let text = '';
  let thoughtChars = 0;
  let traceData = null;

  return {
    setStatus(s) { status.textContent = s; scroll(); },
    think(chunk) {
      thoughtChars += chunk.length;
      status.textContent = `🧠 thinking… ${thoughtChars} chars of reasoning`;
    },
    tool(line) {
      traceLines.push(line);
      status.textContent = `🔧 ${line}`;
      scroll();
    },
    toolDone(ok) {
      const last = traceLines.length - 1;
      if (last >= 0) traceLines[last] += ok ? ' ✓' : ' ✗';
      status.textContent = `🔧 ${traceLines[last]}`;
    },
    memoryTrace(data) {
      traceData = data;
      const parts = [];
      if (data.candidates) parts.push(`${data.candidates} candidates`);
      if (data.recalled) parts.push(`${data.recalled} recalled`);
      if (data.supersededExcluded) parts.push(`${data.supersededExcluded} superseded`);
      if (data.rescued) parts.push(`${data.rescued} safety-rescued`);
      if (parts.length) status.textContent = `🧠 memory: ${parts.join(', ')}`;
    },
    append(chunk) {
      if (text === '') status.remove();
      text += chunk;
      body.innerHTML = renderMarkdown(text);
      scroll();
    },
    finish(finalData) {
      status.remove();
      if (finalData?.message) {
        text = finalData.message;
        body.innerHTML = renderMarkdown(text);
      } else if (!text) {
        el.remove();
        return;
      }
      if (finalData) attachMeta(el, finalData);
      if (traceData) attachMemoryTrace(el, traceData);
      scroll();
    },
  };
}

function attachMeta(el, meta) {
  const m = document.createElement('span');
  m.className = 'meta';
  const bits = [];
  if (meta.usage?.turnTokens) bits.push(`${meta.usage.turnTokens} tokens`);
  if (meta.usage?.llmCalls) bits.push(`${meta.usage.llmCalls} Qwen calls`);
  if (meta.memoryUsed?.length) bits.push(`recalled ${meta.memoryUsed.length} memories`);
  m.textContent = bits.join(' · ');
  el.appendChild(m);

  if (meta.memoryUsed?.length) {
    const chips = document.createElement('div');
    chips.className = 'memory-chips';
    meta.memoryUsed.slice(0, 3).forEach((mm) => {
      const c = document.createElement('span');
      c.className = 'memory-chip';
      c.title = `relevance ${mm.relevance}`;
      c.textContent = mm.text.length > 60 ? mm.text.slice(0, 57) + '…' : mm.text;
      chips.appendChild(c);
    });
    el.appendChild(chips);
  }

  if (meta.toolTrace?.length) {
    const details = document.createElement('details');
    details.className = 'tool-trace';
    const summary = document.createElement('summary');
    summary.textContent = `🔧 ${meta.toolTrace.length} tool call${meta.toolTrace.length > 1 ? 's' : ''}`;
    details.appendChild(summary);
    meta.toolTrace.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'trace-row';
      const argsStr = shortArgs(t.args);
      const resStr = t.result?.error ? `✗ ${t.result.error}` : '✓';
      row.textContent = `${t.tool}(${argsStr}) ${resStr}`;
      details.appendChild(row);
    });
    el.appendChild(details);
  }

  if (meta.photoAnalysis) {
    const p = document.createElement('div');
    p.className = 'photo-analysis';
    p.textContent = `📷 Qwen-VL: ${meta.photoAnalysis}`;
    el.appendChild(p);
  }
}

// Minimal safe markdown: escape everything, then re-enable links/bold/code.
function renderMarkdown(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = /^(https?:\/\/|\/)/.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noopener">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function attachMemoryTrace(el, trace) {
  const details = document.createElement('details');
  details.className = 'memory-trace-details';
  const summary = document.createElement('summary');
  const parts = [];
  if (trace.recalled) parts.push(`${trace.recalled} recalled`);
  if (trace.supersededExcluded) parts.push(`${trace.supersededExcluded} superseded`);
  if (trace.rescued) parts.push(`${trace.rescued} rescued`);
  summary.textContent = `🧠 Memory trace: ${parts.join(', ') || 'no memories'}`;
  details.appendChild(summary);
  if (trace.recalledMemories?.length) {
    trace.recalledMemories.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'trace-row';
      const label = m.rescued ? '🛟 rescued' : `score ${(m.score ?? 0).toFixed(2)}`;
      row.textContent = `${label}: ${m.text?.length > 80 ? m.text.slice(0, 77) + '…' : m.text}`;
      details.appendChild(row);
    });
  }
  if (trace.supersededMemories?.length) {
    trace.supersededMemories.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'trace-row superseded';
      row.textContent = `✕ superseded: ${m.text?.length > 80 ? m.text.slice(0, 77) + '…' : m.text}`;
      details.appendChild(row);
    });
  }
  el.appendChild(details);
}

function renderMemoryDiff(data) {
  const parts = [];
  if (data.newMemories) parts.push(`${data.newMemories} new`);
  if (data.reinforced) parts.push(`${data.reinforced} reinforced`);
  if (data.superseded) parts.push(`${data.superseded} superseded`);
  if (data.profileUpdates) parts.push(`${data.profileUpdates} profile update${data.profileUpdates > 1 ? 's' : ''}`);
  if (!parts.length) return;
  const el = document.createElement('div');
  el.className = 'memory-diff-banner';
  el.textContent = `🧠 Memory updated: ${parts.join(', ')}`;
  messagesEl.appendChild(el);
  scroll();
  loadMemory();
}

function setBusy(busy) {
  sendBtn.disabled = busy;
  inputEl.disabled = busy;
  photoBtn.disabled = busy;
}

function addMessage(role, text, meta, imageDataUrl) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (imageDataUrl) {
    const img = document.createElement('img');
    img.src = imageDataUrl;
    img.className = 'attached-photo';
    img.alt = 'attached field photo';
    el.appendChild(img);
  }
  const span = document.createElement('div');
  span.textContent = text;
  el.appendChild(span);
  messagesEl.appendChild(el);
  scroll();
}

function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  messagesEl.appendChild(el);
  scroll();
}

function renderProposal(p) {
  const el = document.createElement('div');
  el.className = 'proposal';
  el.dataset.id = p.proposalId;
  const ctx = p.context || {};
  const level = ctx.latest?.level != null ? `${ctx.latest.level}cm` : '—';
  el.innerHTML = `
    <h4>💧 Irrigation proposal — pump ${p.action.toUpperCase()}</h4>
    <p class="why">${escapeHtml(p.reason)}</p>
    <p class="ctx">${escapeHtml(p.paddyName)} · level ${level} · stage ${escapeHtml(ctx.growthStage || '—')} · AWD ${escapeHtml(ctx.awdPhase || '—')}</p>
    <div class="actions">
      <button class="approve">✓ Approve</button>
      <button class="reject">✕ Reject</button>
    </div>`;
  el.querySelector('.approve').addEventListener('click', () => decide(p.proposalId, 'approve', el));
  el.querySelector('.reject').addEventListener('click', () => decide(p.proposalId, 'reject', el));
  messagesEl.appendChild(el);
  scroll();
}

async function decide(id, action, el) {
  el.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const res = await fetch(`/api/proposals/${id}/${action}`, {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: '{}',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `failed (${res.status})`);
    el.classList.add('resolved');
    el.querySelector('.actions').remove();
    const result = document.createElement('div');
    if (action === 'approve') {
      const dl = data.downlink || {};
      result.className = 'result ok';
      result.textContent = dl.simulated
        ? `✓ Approved — downlink simulated (no ChirpStack configured), payload ${dl.payload}`
        : `✓ Approved — pump command sent to device (payload ${dl.payload})`;
    } else {
      result.className = 'result rejected';
      result.textContent = '✕ Rejected — no command sent.';
    }
    el.appendChild(result);
    await loadMemory();
  } catch (err) {
    addSystem(`⚠️ ${err.message}`);
  }
}

async function loadMemory() {
  try {
    const res = await fetch('/api/memory', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const profileList = $('#profile-list');
    profileList.innerHTML = '';
    Object.entries(data.profile || {}).forEach(([k, v]) => {
      const li = document.createElement('li');
      li.innerHTML = `<b>${escapeHtml(k.replace(/_/g, ' '))}</b>: ${escapeHtml(formatVal(v))}`;
      profileList.appendChild(li);
    });

    const memList = $('#memory-list');
    memList.innerHTML = '';
    (data.memories || []).forEach((m) => {
      const li = document.createElement('li');
      const boost = m.reinforcement ? ` · ×${m.reinforcement + 1}` : '';
      li.innerHTML = `<span class="tag">${escapeHtml(m.type)} · ${escapeHtml(m.when || '')}${boost}</span>${escapeHtml(m.text)}`;
      memList.appendChild(li);
    });
  } catch {
    /* ignore */
  }
}

function formatVal(v) {
  return Array.isArray(v) ? v.join(', ') : String(v);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function scroll() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
