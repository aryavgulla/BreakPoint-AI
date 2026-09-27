/**
 * BreakPoint AI — C2 Dashboard Server  (v2 — React/SSE edition)
 *
 * Routes
 *   GET  /events          Server-Sent Events stream (all clients)
 *   GET  /events/fuzzer   Dedicated SSE stream for a single MCP fuzzer run.
 *                         Caller POSTs to /run-tests (or MCP calls run_fuzzer),
 *                         then opens this endpoint; the server streams live
 *                         terminal lines and updated radar metrics until the
 *                         Jest child process exits, then sends `done` + closes.
 *   POST /run-tests       Trigger demo-app Jest suite; results stream as SSE
 *   POST /emit            Programmatic SSE injection (used by scripts)
 *   GET  /api/radar       Current Merge Risk Radar dataset
 *   GET  /api/timeline    Persisted threat-mitigation timeline entries
 *   GET  /*               Serves the Vite production build (dist/)
 *
 * SSE event types  (both /events and /events/fuzzer)
 *   log      { type, message, ts }
 *   score    { fuzz, concur, patch }
 *   status   { agent, status }
 *   surface  { transfer, validation, race, auth }
 *   radar    { axes: [{subject, value, fullMark}] }
 *   timeline { id, ts, phase, label, detail, severity }
 *   reset    {}
 *   done     { exitCode, passed, failed }     ← fuzzer stream only
 */

'use strict';

const express    = require('express');
const path       = require('path');
const { spawn }  = require('child_process');
const fs         = require('fs');
const chokidar   = require('chokidar');

const app  = express();
const PORT = process.env.PORT ?? 4242;

// ── Demo state (declared early — addClient references these) ─────────────────
let demoFired    = false;
let demoInterval = null;

// ── In-Memory State ───────────────────────────────────────────────────────────

/** @type {{ axes: {subject:string,value:number,fullMark:number}[] }} */
let radarData = {
  axes: [
    { subject: 'Input Validation', value: 0,  fullMark: 100 },
    { subject: 'Race Conditions',  value: 0,  fullMark: 100 },
    { subject: 'Auth Bypass',      value: 0,  fullMark: 100 },
    { subject: 'Payload Fuzzing',  value: 0,  fullMark: 100 },
    { subject: 'Error Handling',   value: 0,  fullMark: 100 },
    { subject: 'Patch Coverage',   value: 0,  fullMark: 100 },
  ],
};

/** @type {Array<{id:string,ts:number,phase:string,label:string,detail:string,severity:string}>} */
let timelineEntries = [];

let timelineSeq = 0;
function pushTimeline(phase, label, detail, severity = 'info') {
  const entry = {
    id:       `tl-${++timelineSeq}`,
    ts:       Date.now(),
    phase,
    label,
    detail,
    severity,
  };
  timelineEntries.push(entry);
  if (timelineEntries.length > 120) timelineEntries.shift();
  broadcast('timeline', entry);
  return entry;
}

// ── SSE Client Registry ───────────────────────────────────────────────────────
/** @type {Map<string, import('http').ServerResponse>} */
const clients = new Map();

function addClient(res) {
  // Each new browser connection resets the demo so late-joiners see the sequence
  demoFired = false;
  setTimeout(fireDemo, 1500);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
  res.on('close', () => { clearInterval(heartbeat); clients.delete(id); });
  clients.set(id, res);
  return id;
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.values()) {
    try { res.write(payload); } catch (_) { /* client gone */ }
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// Serve Vite production build
const DIST = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
} else {
  // Fall back to old static files during development
  app.use(express.static(path.join(__dirname)));
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/radar', (_req, res) => res.json(radarData));

app.get('/api/timeline', (_req, res) => res.json(timelineEntries));

// ── SSE endpoint ──────────────────────────────────────────────────────────────
app.get('/events', (req, res) => {
  const id = addClient(res);
  res.write(`event: log\ndata: ${JSON.stringify({
    type: 'system',
    message: `C2 channel established — client ${id.slice(0, 8)}`,
    ts: Date.now(),
  })}\n\n`);
  // Send current radar snapshot
  res.write(`event: radar\ndata: ${JSON.stringify(radarData)}\n\n`);
});

// ── Trigger test run ──────────────────────────────────────────────────────────
app.post('/run-tests', (req, res) => {
  res.json({ ok: true, message: 'Test run triggered' });
  runDemoTests();
});

// ── Programmatic inject ───────────────────────────────────────────────────────
app.post('/emit', (req, res) => {
  const { event, data } = req.body ?? {};
  if (!event || !data) return res.status(400).json({ error: 'event and data required' });
  broadcast(event, { ...data, ts: data.ts ?? Date.now() });
  res.json({ ok: true });
});

// ── Fuzzer SSE stream ─────────────────────────────────────────────────────────
//
// GET /events/fuzzer
//
// Opens a per-request SSE channel and immediately spawns (or reuses an already-
// running) Jest child process.  Every stdout/stderr line is forwarded as a `log`
// event; when the child exits the updated radar axes are emitted as a `radar`
// event followed by a `done` event, then the response is closed.
//
// The endpoint is intentionally stateless — each HTTP connection gets its own
// isolated run so the MCP tool and the React dashboard never share a mutable
// subprocess handle.

app.get('/events/fuzzer', (req, res) => {
  // ── SSE headers ──────────────────────────────────────────────────────────
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Keep-alive heartbeat so proxies / load-balancers don't close the socket
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  /** Emit a named SSE event to this response only. */
  function send(event, data) {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  /** Close this SSE channel cleanly. */
  function finish() {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }

  // Abort if the client disconnects before the run finishes
  req.on('close', finish);

  // ── Announce stream open ──────────────────────────────────────────────────
  send('log', { type: 'system', message: '── Fuzzer stream connected — starting Jest run ──', ts: Date.now() });

  // ── Guard: demo-app must exist ────────────────────────────────────────────
  if (!fs.existsSync(path.join(DEMO_APP_DIR, 'package.json'))) {
    send('log', { type: 'fail', message: `demo-app not found at ${DEMO_APP_DIR}`, ts: Date.now() });
    send('done', { exitCode: 1, passed: 0, failed: 0 });
    finish();
    return;
  }

  // ── Spawn Jest ────────────────────────────────────────────────────────────
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // Forward optional query params from the MCP tool / dashboard:
  //   ?pattern=<jest -t pattern>
  //   ?timeout=<ms>
  const testPattern = typeof req.query.pattern === 'string' ? req.query.pattern : null;
  const timeoutMs   = Number(req.query.timeout) || 60_000;

  const args = ['test', '--', '--detectOpenHandles', '--forceExit', '--no-coverage'];
  if (testPattern) args.push('-t', testPattern);

  const child = spawn(npm, args, {
    cwd:   DEMO_APP_DIR,
    env:   { ...process.env, FORCE_COLOR: '0', CI: 'true' },
    shell: true,
  });

  // Kill the child if the client drops the connection mid-run
  req.on('close', () => { try { child.kill('SIGTERM'); } catch (_) {} });

  let stdoutBuf  = '';
  let stderrBuf  = '';
  let passCount  = 0;
  let failCount  = 0;
  let http500Count = 0;

  // ── ANSI stripper ─────────────────────────────────────────────────────────
  const stripAnsi = s => s.replace(/\x1B\[[0-9;]*m/g, '');

  // ── Stream stdout line-by-line ────────────────────────────────────────────
  child.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep incomplete last line in buffer
    for (const raw of lines) {
      const line = stripAnsi(raw).trim();
      if (!line) continue;

      const classified = classifyJestLine(line);
      send('log', { type: classified.type, message: classified.message, ts: Date.now() });

      // Also broadcast to all connected /events clients so the main dashboard
      // stays in sync when a fuzzer run is initiated from the MCP tool.
      broadcast('log', { type: classified.type, message: classified.message, ts: Date.now() });

      if (classified.type === 'pass') passCount++;
      if (classified.type === 'fail') failCount++;

      if (/500|internal server/i.test(line)) {
        http500Count++;
        send('log', { type: 'fail', message: `HTTP 500 — ${line}`, ts: Date.now() });
        broadcast('log', { type: 'fail', message: `HTTP 500 — ${line}`, ts: Date.now() });
        pushTimeline('Fuzzing', 'HTTP 500 Detected', line, 'critical');
      }
      if (/payload|fuzz/i.test(line))   pushTimeline('Fuzzing', 'Payload Fired',      line, 'warn');
      if (/patch|validat|lock|fix/i.test(line)) pushTimeline('Patch', 'Mitigation Applied', line, 'success');
    }
  });

  // ── Stream stderr line-by-line ────────────────────────────────────────────
  child.stderr.on('data', chunk => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    for (const raw of lines) {
      const line = stripAnsi(raw).trim();
      if (!line) continue;
      const classified = classifyJestLine(line);
      send('log',      { type: classified.type, message: classified.message, ts: Date.now() });
      broadcast('log', { type: classified.type, message: classified.message, ts: Date.now() });
      if (classified.type === 'pass') passCount++;
      if (classified.type === 'fail') failCount++;
      if (/500|internal server/i.test(line)) {
        http500Count++;
        send('log',      { type: 'fail', message: `HTTP 500 — ${line}`, ts: Date.now() });
        broadcast('log', { type: 'fail', message: `HTTP 500 — ${line}`, ts: Date.now() });
        pushTimeline('Fuzzing', 'HTTP 500 Detected', line, 'critical');
      }
      if (/payload|fuzz/i.test(line))              pushTimeline('Fuzzing', 'Payload Fired',      line, 'warn');
      if (/patch|validat|lock|fix/i.test(line))    pushTimeline('Patch',   'Mitigation Applied', line, 'success');
    }
  });

  // ── On process exit: compute metrics, emit radar + done ──────────────────
  child.on('close', code => {
    const success  = code === 0;
    const total    = passCount + failCount || 1;
    const passRate = Math.round((passCount / total) * 100);
    const fuzz     = passRate;
    const concur   = Math.max(0, passRate - (failCount > 0 ? 15 : 0));
    const patch    = success ? 95 : Math.min(passRate + 10, 85);

    // Summary log line
    const summaryLine = {
      type:    success ? 'pass' : 'fail',
      message: `── Jest finished (exit ${code}) — ${passCount} passed, ${failCount} failed ──`,
      ts:      Date.now(),
    };
    send('log', summaryLine);
    broadcast('log', summaryLine);

    // Score update (broadcast to main dashboard clients too)
    const scorePayload = { fuzz, concur, patch };
    send('score', scorePayload);
    broadcast('score', scorePayload);

    // Attack surface
    const surfacePayload = {
      transfer:   failCount > 0 ? 'vulnerable' : 'clean',
      validation: failCount > 0 ? 'vulnerable' : 'patched',
      race:       concur < 60   ? 'vulnerable' : 'clean',
      auth:       'clean',
    };
    send('surface', surfacePayload);
    broadcast('surface', surfacePayload);

    // Agent status
    const statusA = { agent: 'A', status: success ? 'done' : 'error' };
    const statusB = { agent: 'B', status: success ? 'done' : 'error' };
    send('status', statusA);  send('status', statusB);
    broadcast('status', statusA); broadcast('status', statusB);

    // Recompute and persist radar state
    radarData = {
      axes: [
        { subject: 'Input Validation', value: Math.min(100, fuzz),                                        fullMark: 100 },
        { subject: 'Race Conditions',  value: concur,                                                      fullMark: 100 },
        { subject: 'Auth Bypass',      value: success ? 90 : 45,                                           fullMark: 100 },
        { subject: 'Payload Fuzzing',  value: fuzz,                                                        fullMark: 100 },
        { subject: 'Error Handling',   value: http500Count > 0 ? Math.max(20, fuzz - 20) : fuzz,           fullMark: 100 },
        { subject: 'Patch Coverage',   value: patch,                                                       fullMark: 100 },
      ],
    };

    // Stream the fresh radar to this dedicated channel AND the main broadcast
    send('radar', radarData);
    broadcast('radar', radarData);

    // Timeline result entry
    pushTimeline(
      'Result',
      success ? 'All Tests Passed' : 'Tests Failed',
      `Exit ${code} — ${passCount}P/${failCount}F`,
      success ? 'success' : 'critical',
    );

    // Terminal `done` event lets the React hook know the stream is over
    send('done', { exitCode: code ?? 1, passed: passCount, failed: failCount });
    finish();
  });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
if (fs.existsSync(DIST)) {
  app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

// ── Test Runner ───────────────────────────────────────────────────────────────
// Resolve target directory: BREAKPOINT_TARGET > DEMO_APP_PATH > default demo-app/
const DEMO_APP_DIR = process.env.BREAKPOINT_TARGET
  ? path.resolve(process.env.BREAKPOINT_TARGET)
  : process.env.DEMO_APP_PATH
    ? path.resolve(process.env.DEMO_APP_PATH)
    : path.resolve(__dirname, '..', 'demo-app');

function runDemoTests() {
  broadcast('log',     { type: 'system', message: '── Test run starting ──', ts: Date.now() });
  broadcast('status',  { agent: 'A', status: 'running' });
  broadcast('status',  { agent: 'B', status: 'running' });
  broadcast('surface', { transfer: 'scanning', validation: 'scanning', race: 'scanning', auth: 'unknown' });
  pushTimeline('Scan', 'Test run triggered', 'Jest suite starting on demo-app', 'info');

  if (!fs.existsSync(path.join(DEMO_APP_DIR, 'package.json'))) {
    broadcast('log', { type: 'fail', message: `demo-app not found at ${DEMO_APP_DIR}`, ts: Date.now() });
    broadcast('status', { agent: 'A', status: 'error' });
    broadcast('status', { agent: 'B', status: 'error' });
    return;
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npm, ['test', '--', '--no-coverage', '--forceExit', '--detectOpenHandles'], {
    cwd:   DEMO_APP_DIR,
    env:   { ...process.env, FORCE_COLOR: '0' },
    shell: true,
  });

  let stdout = '';
  let stderr = '';
  let passCount = 0;
  let failCount = 0;
  let http500Count = 0;

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    const lines = stdout.split('\n');
    stdout = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\x1B\[[0-9;]*m/g, '').trim();
      if (!line) continue;
      const classified = classifyJestLine(line);
      broadcast('log', { type: classified.type, message: classified.message, ts: Date.now() });
      if (classified.type === 'pass')    passCount++;
      if (classified.type === 'fail')    failCount++;
      if (/500|internal server/i.test(line)) {
        http500Count++;
        broadcast('log', { type: 'fail', message: `HTTP 500 — ${line}`, ts: Date.now() });
        pushTimeline('Fuzzing', 'HTTP 500 Detected', line, 'critical');
      }
      if (/payload|fuzz/i.test(line))
        pushTimeline('Fuzzing', 'Payload Fired', line, 'warn');
      if (/patch|validat|lock|fix/i.test(line))
        pushTimeline('Patch', 'Mitigation Applied', line, 'success');
    }
  });

  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
    const lines = stderr.split('\n');
    stderr = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\x1B\[[0-9;]*m/g, '').trim();
      if (!line) continue;
      const classified = classifyJestLine(line);
      broadcast('log', { type: classified.type, message: classified.message, ts: Date.now() });
      if (classified.type === 'pass') passCount++;
      if (classified.type === 'fail') failCount++;
      if (/500|internal server/i.test(line)) {
        http500Count++;
        broadcast('log', { type: 'fail', message: `HTTP 500 — ${line}`, ts: Date.now() });
        pushTimeline('Fuzzing', 'HTTP 500 Detected', line, 'critical');
      }
      if (/payload|fuzz/i.test(line))
        pushTimeline('Fuzzing', 'Payload Fired', line, 'warn');
      if (/patch|validat|lock|fix/i.test(line))
        pushTimeline('Patch', 'Mitigation Applied', line, 'success');
    }
  });

  child.on('close', code => {
    const success   = code === 0;
    const total     = passCount + failCount || 1;
    const passRate  = Math.round((passCount / total) * 100);
    const fuzz      = passRate;
    const concur    = Math.max(0, passRate - (failCount > 0 ? 15 : 0));
    const patch     = success ? 95 : Math.min(passRate + 10, 85);

    broadcast('log', {
      type:    success ? 'pass' : 'fail',
      message: `── Test run finished (exit ${code}) — ${passCount} passed, ${failCount} failed ──`,
      ts:      Date.now(),
    });
    broadcast('score',   { fuzz, concur, patch });
    broadcast('surface', {
      transfer:   failCount > 0 ? 'vulnerable' : 'clean',
      validation: failCount > 0 ? 'vulnerable' : 'patched',
      race:       concur < 60   ? 'vulnerable' : 'clean',
      auth:       'clean',
    });
    broadcast('status', { agent: 'A', status: success ? 'done' : 'error' });
    broadcast('status', { agent: 'B', status: success ? 'done' : 'error' });

    // Update radar
    radarData = {
      axes: [
        { subject: 'Input Validation', value: Math.min(100, fuzz),    fullMark: 100 },
        { subject: 'Race Conditions',  value: concur,                  fullMark: 100 },
        { subject: 'Auth Bypass',      value: success ? 90 : 45,       fullMark: 100 },
        { subject: 'Payload Fuzzing',  value: fuzz,                    fullMark: 100 },
        { subject: 'Error Handling',   value: http500Count > 0 ? Math.max(20, fuzz - 20) : fuzz, fullMark: 100 },
        { subject: 'Patch Coverage',   value: patch,                   fullMark: 100 },
      ],
    };
    broadcast('radar', radarData);
    pushTimeline('Result', success ? 'All Tests Passed' : 'Tests Failed', `Exit ${code} — ${passCount}P/${failCount}F`, success ? 'success' : 'critical');
  });
}

// ── Jest Output Classifier ────────────────────────────────────────────────────
function classifyJestLine(line) {
  if (/✓|✔|PASS|passed/i.test(line))               return { type: 'pass',    message: line };
  if (/✕|✗|✘|FAIL|failed|Error|throw/i.test(line)) return { type: 'fail',    message: line };
  if (/warn|deprecat/i.test(line))                  return { type: 'warn',    message: line };
  if (/payload|fuzz|inject|null|negativ/i.test(line)) return { type: 'payload', message: line };
  if (/patch|validat|lock|fix/i.test(line))         return { type: 'patch',   message: line };
  return { type: 'info', message: line };
}

// ── File Watcher ──────────────────────────────────────────────────────────────
const watchDir = path.join(DEMO_APP_DIR, 'tests');
if (fs.existsSync(watchDir)) {
  chokidar.watch(watchDir, { ignoreInitial: true }).on('add', filePath => {
    const rel = path.relative(DEMO_APP_DIR, filePath);
    broadcast('log', { type: 'system', message: `New test file detected: ${rel}`, ts: Date.now() });
    pushTimeline('Discovery', 'New Test File', rel, 'info');
  });
}

// ── Demo Sequence ─────────────────────────────────────────────────────────────
const DEMO_PAYLOADS = [
  { type: 'system',  msg: 'BreakPoint AI initialised — scanning demo-app…' },
  { type: 'info',    msg: 'Reading openapi.json — found /api/v1/transfer (POST)' },
  { type: 'info',    msg: 'Spawning Subagent A (Concurrency Tester)' },
  { type: 'info',    msg: 'Spawning Subagent B (Payload Fuzzer)' },
  { type: 'payload', msg: 'Fuzzing: { "senderId": null, "recipientId": "alice", "amount": -999 }' },
  { type: 'payload', msg: 'Fuzzing: { "senderId": "", "recipientId": "", "amount": 0 }' },
  { type: 'payload', msg: 'Fuzzing: { "senderId": "bob", "amount": "NaN" }' },
  { type: 'fail',    msg: 'HTTP 500 Internal Server Error — /api/v1/transfer (negative amount)' },
  { type: 'payload', msg: 'Concurrency: 10 simultaneous POST /api/v1/transfer requests' },
  { type: 'warn',    msg: 'Potential race condition detected on balance decrement' },
  { type: 'fail',    msg: 'Transfer accepted negative amount — VULNERABILITY FOUND' },
  { type: 'patch',   msg: 'Auto-patching: adding input validation to routes/transfer.js' },
  { type: 'pass',    msg: 'Re-run: negative amount now rejected with 400 Bad Request' },
  { type: 'pass',    msg: 'Re-run: null fields rejected with 422 Unprocessable Entity' },
  { type: 'pass',    msg: 'Concurrency test: race condition resolved via mutex lock' },
  { type: 'system',  msg: '── Scan complete ──' },
];

function fireDemo() {
  if (demoFired) return;
  demoFired = true;

  // Clear any previous in-flight demo interval
  if (demoInterval) { clearInterval(demoInterval); demoInterval = null; }

  // Reset timeline for fresh run
  timelineEntries = [];
  timelineSeq = 0;

  // Seed timeline
  pushTimeline('Init',    'System Boot',       'BreakPoint AI initialised',                   'info');
  pushTimeline('Scan',    'Surface Discovery', 'OpenAPI spec loaded — 3 endpoints found',      'info');
  pushTimeline('Fuzzing', 'Agent A Spawned',   'Concurrency tester ready',                     'info');
  pushTimeline('Fuzzing', 'Agent B Spawned',   'Payload fuzzer ready',                         'info');

  // Broadcast timeline seed to already-connected clients
  broadcast('reset', {});
  timelineEntries.forEach(e => broadcast('timeline', e));

  let i = 0;
  demoInterval = setInterval(() => {
    if (i >= DEMO_PAYLOADS.length) {
      clearInterval(demoInterval);
      demoInterval = null;
      // Final radar + scores
      radarData = {
        axes: [
          { subject: 'Input Validation', value: 88, fullMark: 100 },
          { subject: 'Race Conditions',  value: 71, fullMark: 100 },
          { subject: 'Auth Bypass',      value: 90, fullMark: 100 },
          { subject: 'Payload Fuzzing',  value: 82, fullMark: 100 },
          { subject: 'Error Handling',   value: 75, fullMark: 100 },
          { subject: 'Patch Coverage',   value: 95, fullMark: 100 },
        ],
      };
      broadcast('score',   { fuzz: 82, concur: 71, patch: 95 });
      broadcast('radar',   radarData);
      broadcast('surface', { transfer: 'patched', validation: 'patched', race: 'clean', auth: 'clean' });
      broadcast('status',  { agent: 'A', status: 'done' });
      broadcast('status',  { agent: 'B', status: 'done' });
      pushTimeline('Result', 'Scan Complete', '15 events, 2 vulns found & patched', 'success');
      return;
    }
    const p = DEMO_PAYLOADS[i];
    broadcast('log', { type: p.type, message: p.msg, ts: Date.now() });

    // Mirror key events to timeline
    if (p.type === 'fail' && /500|VULNERABILITY/i.test(p.msg))
      pushTimeline('Fuzzing', 'Vulnerability Detected', p.msg, 'critical');
    else if (p.type === 'patch')
      pushTimeline('Patch', 'Mitigation Applied', p.msg, 'success');
    else if (p.type === 'warn')
      pushTimeline('Analysis', 'Warning Raised', p.msg, 'warn');
    i++;
  }, 700);
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  BreakPoint AI — C2 Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Target: ${DEMO_APP_DIR}`);
  console.log(`  Tip: set BREAKPOINT_TARGET to point at any project on your machine.\n`);
});
