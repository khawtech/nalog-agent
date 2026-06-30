const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const formEl = $('#chat-form');
const inputEl = $('#chat-input');
const sendBtn = $('#send-btn');

let sessionId = localStorage.getItem('nalog-agent-session') || null;

init();

async function init() {
  await loadHealth();
  await loadMemory();
  addSystem('Welcome to the NaLog Agent — your AWD irrigation assistant. Ask about a paddy, in Thai or English.');

  formEl.addEventListener('submit', onSubmit);
  $('#refresh-memory').addEventListener('click', loadMemory);
  document.querySelectorAll('.suggestions button').forEach((b) =>
    b.addEventListener('click', () => {
      inputEl.value = b.dataset.q;
      formEl.requestSubmit();
    })
  );
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

async function onSubmit(e) {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  addMessage('user', text);
  setBusy(true);
  const typing = addTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: text }),
    });
    const data = await res.json();
    typing.remove();
    if (!res.ok) {
      addSystem(`⚠️ ${data.error || 'Something went wrong'}`);
      return;
    }
    sessionId = data.sessionId;
    localStorage.setItem('nalog-agent-session', sessionId);
    addMessage('assistant', data.message, data);
    (data.proposals || []).forEach(renderProposal);
    await loadMemory();
  } catch (err) {
    typing.remove();
    addSystem(`⚠️ ${err.message}`);
  } finally {
    setBusy(false);
    inputEl.focus();
  }
}

function setBusy(busy) {
  sendBtn.disabled = busy;
  inputEl.disabled = busy;
}

function addMessage(role, text, meta) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  if (meta && (meta.memoryUsed?.length || meta.usage)) {
    const m = document.createElement('span');
    m.className = 'meta';
    const bits = [];
    if (meta.usage?.turnTokens) bits.push(`${meta.usage.turnTokens} tokens`);
    if (meta.memoryUsed?.length) bits.push(`recalled ${meta.memoryUsed.length} memories`);
    m.textContent = bits.join(' · ');
    el.appendChild(m);

    if (meta.memoryUsed?.length) {
      const chips = document.createElement('div');
      chips.className = 'memory-chips';
      meta.memoryUsed.slice(0, 3).forEach((mm) => {
        const c = document.createElement('span');
        c.className = 'memory-chip';
        c.textContent = mm.text.length > 60 ? mm.text.slice(0, 57) + '…' : mm.text;
        chips.appendChild(c);
      });
      el.appendChild(chips);
    }
  }
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

function addTyping() {
  const el = document.createElement('div');
  el.className = 'msg assistant typing';
  el.textContent = 'NaLog Agent is thinking…';
  messagesEl.appendChild(el);
  scroll();
  return el;
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
    const res = await fetch(`/api/proposals/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
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
    const data = await (await fetch('/api/memory')).json();
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
      li.innerHTML = `<span class="tag">${escapeHtml(m.type)} · ${escapeHtml(m.when || '')}</span>${escapeHtml(m.text)}`;
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
