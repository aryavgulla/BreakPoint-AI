/**
 * BreakPoint AI — C2 Dashboard Client
 * Connects to the Express SSE backend and drives the entire UI.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  total: 0,
  pass: 0,
  fail: 0,
  warn: 0,
  fuzzScore: null,
  concurScore: null,
  patchScore: null,
  logLines: 0,
  running: false,
};

// ── Clock ─────────────────────────────────────────────────────────────────────
function tickClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
setInterval(tickClock, 1000);
tickClock();

// ── SSE Connection ────────────────────────────────────────────────────────────
let evtSource = null;

function connectSSE() {
  if (evtSource) {
    evtSource.close();
    evtSource = null;
  }

  setServerStatus('connecting');
  evtSource = new EventSource('/events');

  evtSource.addEventListener('open', () => {
    setServerStatus('online');
  });

  evtSource.addEventListener('error', () => {
    setServerStatus('offline');
    setTimeout(connectSSE, 3000);
  });

  // Named event types emitted by the server
  evtSource.addEventListener('log',    e => handleLog(JSON.parse(e.data)));
  evtSource.addEventListener('score',  e => handleScore(JSON.parse(e.data)));
  evtSource.addEventListener('status', e => handleAgentStatus(JSON.parse(e.data)));
  evtSource.addEventListener('surface',e => handleSurface(JSON.parse(e.data)));
  evtSource.addEventListener('reset',  () => resetUI());
}

connectSSE();

// ── Server Status ─────────────────────────────────────────────────────────────
function setServerStatus(status) {
  const el = document.getElementById('server-status');
  if (!el) return;
  el.className = `pulse-dot ${status} text-gray-300 text-xs font-medium`;
  const labels = { online: 'Server Online', offline: 'Server Offline', connecting: 'Connecting…', idle: 'Idle' };
  el.textContent = labels[status] ?? status;
}

// ── Log Handler ───────────────────────────────────────────────────────────────
const LOG_COLORS = {
  pass:    'text-green-400',
  fail:    'text-red-400',
  warn:    'text-amber-400',
  info:    'text-cyan-400',
  payload: 'text-violet-400',
  patch:   'text-amber-300',
  system:  'text-gray-400',
};

const BADGES = {
  pass:    '<span class="badge bg-green-500/15 text-green-400 border border-green-500/25 mr-2">PASS</span>',
  fail:    '<span class="badge bg-red-500/15 text-red-400 border border-red-500/25 mr-2">FAIL</span>',
  warn:    '<span class="badge bg-amber-500/15 text-amber-400 border border-amber-500/25 mr-2">WARN</span>',
  payload: '<span class="badge bg-violet-500/15 text-violet-400 border border-violet-500/25 mr-2">PAYLOAD</span>',
  patch:   '<span class="badge bg-amber-500/15 text-amber-300 border border-amber-400/25 mr-2">PATCH</span>',
  info:    '<span class="badge bg-cyan-500/15 text-cyan-400 border border-cyan-500/25 mr-2">INFO</span>',
  system:  '<span class="badge bg-gray-700 text-gray-400 border border-gray-600 mr-2">SYS</span>',
};

function handleLog(data) {
  const { type = 'info', message = '', ts } = data;
  const container = document.getElementById('log-container');
  if (!container) return;

  state.total++;
  if (type === 'pass') state.pass++;
  else if (type === 'fail') state.fail++;
  else if (type === 'warn') state.warn++;

  updateStats();
  state.logLines++;

  const timestamp = ts ? new Date(ts).toISOString().slice(11, 23) : new Date().toISOString().slice(11, 23);
  const colorClass = LOG_COLORS[type] ?? 'text-gray-300';
  const badge = BADGES[type] ?? BADGES.info;

  const line = document.createElement('div');
  line.className = `log-line flex items-start gap-2 py-1 px-2 rounded hover:bg-gray-800/50 group`;
  line.innerHTML = `
    <span class="text-gray-600 select-none shrink-0 tabular-nums">${timestamp}</span>
    ${badge}
    <span class="${colorClass} break-all leading-relaxed">${escapeHtml(message)}</span>
  `;

  container.appendChild(line);

  // Auto-scroll
  container.scrollTop = container.scrollHeight;

  // Update badge
  const logBadge = document.getElementById('log-badge');
  if (logBadge) logBadge.textContent = `${state.logLines} events`;

  // Timeline tick
  addTimelineTick(type);

  // Trim to 500 lines
  while (container.children.length > 500) {
    container.removeChild(container.firstChild);
  }
}

// ── Score Handler ─────────────────────────────────────────────────────────────
function handleScore(data) {
  const { fuzz, concur, patch } = data;

  if (fuzz   != null) { state.fuzzScore   = fuzz;   document.getElementById('score-fuzz').textContent   = fuzz + '%'; }
  if (concur != null) { state.concurScore = concur; document.getElementById('score-concur').textContent = concur + '%'; }
  if (patch  != null) { state.patchScore  = patch;  document.getElementById('score-patch').textContent  = patch + '%'; }

  const scores = [state.fuzzScore, state.concurScore, state.patchScore].filter(v => v != null);
  if (scores.length === 0) return;
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  updateScoreRing(avg);
}

function updateScoreRing(score) {
  const ring  = document.getElementById('score-ring');
  const val   = document.getElementById('score-value');
  const label = document.getElementById('score-label');
  if (!ring || !val || !label) return;

  const circumference = 351.86;
  const offset = circumference - (score / 100) * circumference;
  ring.style.strokeDashoffset = offset;

  // Color gradient based on score
  let color, labelText, labelClass;
  if (score >= 80)      { color = '#3fb950'; labelText = 'SAFE TO MERGE';   labelClass = 'text-green-400'; }
  else if (score >= 55) { color = '#d29922'; labelText = 'REVIEW REQUIRED'; labelClass = 'text-amber-400'; }
  else                  { color = '#f85149'; labelText = 'DO NOT MERGE';    labelClass = 'text-red-400';   }

  ring.setAttribute('stroke', color);
  val.textContent   = score;
  val.className     = `text-3xl font-bold tabular-nums ${labelClass}`;
  label.textContent = labelText;
  label.className   = `mt-3 text-xs font-semibold uppercase tracking-wider ${labelClass}`;
}

// ── Agent Status ──────────────────────────────────────────────────────────────
function handleAgentStatus(data) {
  const { agent, status } = data;
  const map = { A: 'agent-a-status', B: 'agent-b-status' };
  const el = document.getElementById(map[agent]);
  if (!el) return;

  const colors = { running: 'text-cyan-400', done: 'text-green-400', error: 'text-red-400', idle: 'text-gray-500' };
  el.textContent = status;
  el.className = colors[status] ?? 'text-gray-500';

  // Update dot on the parent label
  const dotMap = { running: 'online', done: 'online', error: 'offline', idle: 'idle' };
  const parentSpan = el.previousElementSibling;
  if (parentSpan) {
    parentSpan.className = `pulse-dot ${dotMap[status] ?? 'idle'} text-gray-300`;
  }
}

// ── Attack Surface ────────────────────────────────────────────────────────────
function handleSurface(data) {
  const badgeMap = {
    vulnerable: 'badge bg-red-500/15 text-red-400 border border-red-500/30',
    patched:    'badge bg-green-500/15 text-green-400 border border-green-500/30',
    scanning:   'badge bg-amber-500/15 text-amber-400 border border-amber-500/30',
    clean:      'badge bg-cyan-500/15 text-cyan-400 border border-cyan-500/30',
    unknown:    'badge bg-gray-700 text-gray-400 border border-gray-600',
  };
  const textMap = {
    vulnerable: 'VULNERABLE',
    patched:    'PATCHED',
    scanning:   'SCANNING',
    clean:      'CLEAN',
    unknown:    '—',
  };
  Object.entries(data).forEach(([key, val]) => {
    const el = document.getElementById(`surface-${key}`);
    if (!el) return;
    el.className = badgeMap[val] ?? badgeMap.unknown;
    el.textContent = textMap[val] ?? val.toUpperCase();
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats() {
  document.getElementById('stat-total').textContent = state.total;
  document.getElementById('stat-pass').textContent  = state.pass;
  document.getElementById('stat-fail').textContent  = state.fail;
  document.getElementById('stat-warn').textContent  = state.warn;
}

// ── Timeline ──────────────────────────────────────────────────────────────────
const TICK_COLORS = {
  pass:    '#3fb950',
  fail:    '#f85149',
  warn:    '#d29922',
  payload: '#bc8cff',
  patch:   '#e3b341',
  info:    '#58a6ff',
  system:  '#30363d',
};

function addTimelineTick(type) {
  const container = document.getElementById('timeline');
  if (!container) return;
  const tick = document.createElement('div');
  tick.title = type.toUpperCase();
  tick.style.cssText = `width:6px;height:20px;border-radius:2px;background:${TICK_COLORS[type] ?? '#30363d'};opacity:.85;flex-shrink:0;`;
  container.appendChild(tick);
  // Keep last 200
  while (container.children.length > 200) container.removeChild(container.firstChild);
}

// ── Trigger Test Run ──────────────────────────────────────────────────────────
async function triggerTestRun() {
  if (state.running) return;
  state.running = true;
  const btn = document.getElementById('btn-run');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ RUNNING…'; btn.classList.add('opacity-50'); }

  try {
    const res = await fetch('/run-tests', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    handleLog({ type: 'fail', message: `Failed to trigger test run: ${err.message}` });
  } finally {
    state.running = false;
    if (btn) { btn.disabled = false; btn.textContent = '▶ RUN TESTS'; btn.classList.remove('opacity-50'); }
  }
}

// ── Clear Log ─────────────────────────────────────────────────────────────────
function clearLog() {
  const container = document.getElementById('log-container');
  if (container) container.innerHTML = '';
  const tl = document.getElementById('timeline');
  if (tl) tl.innerHTML = '';
  const logBadge = document.getElementById('log-badge');
  if (logBadge) logBadge.textContent = 'Awaiting stream…';
  state.total = state.pass = state.fail = state.warn = state.logLines = 0;
  updateStats();
}

// ── Reset UI (on server reset event) ─────────────────────────────────────────
function resetUI() {
  clearLog();
  state.fuzzScore = state.concurScore = state.patchScore = null;
  document.getElementById('score-fuzz').textContent   = '—';
  document.getElementById('score-concur').textContent = '—';
  document.getElementById('score-patch').textContent  = '—';
  document.getElementById('score-value').textContent  = '0';
  document.getElementById('score-label').textContent  = 'Awaiting Results';
  document.getElementById('score-ring').style.strokeDashoffset = '351.86';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
