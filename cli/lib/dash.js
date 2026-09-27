'use strict';
/**
 * lib/dash.js
 *
 * CLI command: breakpoint dash --target <dir> [--port 4242]
 *
 * Starts the BreakPoint AI web dashboard pointed at any target directory.
 * The dashboard UI, SSE streams, and test runner all operate on `targetDir`.
 * No hardcoded paths — works from any install location.
 */

const express    = require('express');
const path       = require('path');
const { spawn }  = require('child_process');
const fs         = require('fs');
const chokidar   = require('chokidar');
const { runTests, detectTestRunner } = require('./run-tests-lib');
const { discoverEntryFiles }         = require('./discover');

module.exports = function dash(targetDir, options = {}) {
  const { port = 4242 } = options;

  const app = express();
  app.use(express.json());

  // ── Resolve UI dist directory (do NOT register as middleware yet) ─────────────
  // API routes must be registered first so they take priority over the SPA fallback.
  // Resolution order:
  //   1. cli/public/              — bundled inside the npm package (global install)
  //   2. dashboard/client/dist    — sibling in the repo (development)
  const DIST = [
    path.resolve(__dirname, '..', 'public'),
    path.resolve(__dirname, '..', '..', 'dashboard', 'client', 'dist'),
  ].find(d => fs.existsSync(path.join(d, 'index.html'))) || null;

  if (DIST) console.log(`[breakpoint] UI served from: ${DIST}`);

  // ── Probe the target project ─────────────────────────────────────────────────
  const discovered = discoverEntryFiles(targetDir);

  // ── In-memory state ──────────────────────────────────────────────────────────
  let radarData = {
    axes: [
      { subject: 'Input Validation', value: 0, fullMark: 100 },
      { subject: 'Race Conditions',  value: 0, fullMark: 100 },
      { subject: 'Auth Bypass',      value: 0, fullMark: 100 },
      { subject: 'Payload Fuzzing',  value: 0, fullMark: 100 },
      { subject: 'Error Handling',   value: 0, fullMark: 100 },
      { subject: 'Patch Coverage',   value: 0, fullMark: 100 },
    ],
  };

  let timelineEntries = [];
  let timelineSeq     = 0;

  function pushTimeline(phase, label, detail, severity = 'info') {
    const entry = { id: `tl-${++timelineSeq}`, ts: Date.now(), phase, label, detail, severity };
    timelineEntries.push(entry);
    if (timelineEntries.length > 120) timelineEntries.shift();
    broadcast('timeline', entry);
    return entry;
  }

  // ── SSE clients ──────────────────────────────────────────────────────────────
  const clients = new Map();

  function addClient(res) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const hb = setInterval(() => res.write(': ping\n\n'), 20_000);
    res.on('close', () => { clearInterval(hb); clients.delete(id); });
    clients.set(id, res);
    return id;
  }

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients.values()) {
      try { res.write(payload); } catch (_) {}
    }
  }

  // ── REST API ─────────────────────────────────────────────────────────────────
  app.get('/api/radar',     (_req, res) => res.json(radarData));
  app.get('/api/timeline',  (_req, res) => res.json(timelineEntries));
  app.get('/api/target',    (_req, res) => res.json({
    targetDir,
    testRunner: discovered.testRunner,
    sourceFiles: discovered.sourceFiles.length,
    specFile: discovered.specFile,
  }));

  app.post('/run-tests', (req, res) => {
    res.json({ ok: true, message: 'Test run triggered', target: targetDir });
    spawnTestRun(null);
  });

  app.post('/emit', (req, res) => {
    const { event, data } = req.body ?? {};
    if (!event || !data) return res.status(400).json({ error: 'event and data required' });
    broadcast(event, { ...data, ts: data.ts ?? Date.now() });
    res.json({ ok: true });
  });

  // ── Main SSE endpoint ─────────────────────────────────────────────────────────
  app.get('/events', (req, res) => {
    const id = addClient(res);
    res.write(`event: log\ndata: ${JSON.stringify({
      type: 'system',
      message: `C2 channel established — target: ${targetDir}`,
      ts: Date.now(),
    })}\n\n`);
    res.write(`event: radar\ndata: ${JSON.stringify(radarData)}\n\n`);
    // Send current timeline
    for (const e of timelineEntries) {
      res.write(`event: timeline\ndata: ${JSON.stringify(e)}\n\n`);
    }
  });

  // ── Fuzzer SSE stream ─────────────────────────────────────────────────────────
  app.get('/events/fuzzer', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();

    const hb = setInterval(() => res.write(': ping\n\n'), 20_000);

    function send(event, data) {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    function finish() {
      clearInterval(hb);
      if (!res.writableEnded) res.end();
    }

    req.on('close', finish);
    send('log', { type: 'system', message: `Fuzzer stream connected — target: ${targetDir}`, ts: Date.now() });

    const pkgJson = path.join(targetDir, 'package.json');
    const requirementsTxt = path.join(targetDir, 'requirements.txt');
    const hasPkg  = fs.existsSync(pkgJson);
    const hasPy   = !hasPkg && (fs.existsSync(requirementsTxt) || discovered.testRunner === 'pytest');

    if (!hasPkg && !hasPy) {
      send('log', { type: 'fail', message: `No package.json or Python project found in ${targetDir}`, ts: Date.now() });
      send('done', { exitCode: 1, passed: 0, failed: 0 });
      finish();
      return;
    }

    // Determine runner and command
    const runner = discovered.testRunner;
    const IS_WIN = process.platform === 'win32';
    const NPM    = IS_WIN ? 'npm.cmd' : 'npm';
    const PY     = IS_WIN ? 'python'  : 'python3';

    const testPattern = typeof req.query.pattern === 'string' ? req.query.pattern : null;

    let cmd, args;
    if (runner === 'pytest') {
      cmd  = PY;
      args = ['-m', 'pytest', '-v'];
      if (testPattern) args.push('-k', testPattern);
    } else {
      cmd  = NPM;
      args = ['test', '--', '--detectOpenHandles', '--forceExit', '--no-coverage'];
      if (testPattern) args.push('-t', testPattern);
    }

    const child = spawn(cmd, args, {
      cwd:   targetDir,
      env:   { ...process.env, FORCE_COLOR: '0', CI: 'true' },
      shell: IS_WIN,
    });

    req.on('close', () => { try { child.kill('SIGTERM'); } catch (_) {} });

    let stdoutBuf = '';
    let stderrBuf = '';
    let passCount = 0;
    let failCount = 0;
    let http500Count = 0;

    const stripAnsi = s => s.replace(/\x1B\[[0-9;]*m/g, '');

    function processLine(raw) {
      const line = stripAnsi(raw).trim();
      if (!line) return;
      const cl = classifyTestLine(line);
      send('log', { type: cl.type, message: cl.message, ts: Date.now() });
      broadcast('log', { type: cl.type, message: cl.message, ts: Date.now() });
      if (cl.type === 'pass') passCount++;
      if (cl.type === 'fail') failCount++;
      if (/500|internal server/i.test(line)) {
        http500Count++;
        pushTimeline('Fuzzing', 'HTTP 500 Detected', line, 'critical');
      }
      if (/payload|fuzz/i.test(line))           pushTimeline('Fuzzing', 'Payload Fired',      line, 'warn');
      if (/patch|validat|lock|fix/i.test(line)) pushTimeline('Patch',   'Mitigation Applied', line, 'success');
    }

    child.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const l of lines) processLine(l);
    });

    child.stderr.on('data', chunk => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();
      for (const l of lines) processLine(l);
    });

    child.on('close', code => {
      const success  = code === 0;
      const total    = passCount + failCount || 1;
      const passRate = Math.round((passCount / total) * 100);
      const fuzz     = passRate;
      const concur   = Math.max(0, passRate - (failCount > 0 ? 15 : 0));
      const patch    = success ? 95 : Math.min(passRate + 10, 85);

      radarData = {
        axes: [
          { subject: 'Input Validation', value: Math.min(100, fuzz),                            fullMark: 100 },
          { subject: 'Race Conditions',  value: concur,                                          fullMark: 100 },
          { subject: 'Auth Bypass',      value: success ? 90 : 45,                               fullMark: 100 },
          { subject: 'Payload Fuzzing',  value: fuzz,                                            fullMark: 100 },
          { subject: 'Error Handling',   value: http500Count > 0 ? Math.max(20, fuzz - 20) : fuzz, fullMark: 100 },
          { subject: 'Patch Coverage',   value: patch,                                           fullMark: 100 },
        ],
      };

      send('score',   { fuzz, concur, patch });
      send('radar',   radarData);
      send('surface', { transfer: failCount > 0 ? 'vulnerable' : 'clean', validation: failCount > 0 ? 'vulnerable' : 'patched', race: concur < 60 ? 'vulnerable' : 'clean', auth: 'clean' });
      send('status',  { agent: 'A', status: success ? 'done' : 'error' });
      send('status',  { agent: 'B', status: success ? 'done' : 'error' });
      broadcast('score',  { fuzz, concur, patch });
      broadcast('radar',  radarData);
      pushTimeline('Result', success ? 'All Tests Passed' : 'Tests Failed', `Exit ${code} — ${passCount}P/${failCount}F`, success ? 'success' : 'critical');
      send('done', { exitCode: code ?? 1, passed: passCount, failed: failCount });
      finish();
    });
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────────
  if (fs.existsSync(DIST)) {
    app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
  }

  // ── File watcher: watch tests dir of target project ──────────────────────────
  const watchDir = path.join(targetDir, 'tests');
  if (fs.existsSync(watchDir)) {
    chokidar.watch(watchDir, { ignoreInitial: true }).on('add', filePath => {
      const rel = path.relative(targetDir, filePath);
      broadcast('log', { type: 'system', message: `New test file: ${rel}`, ts: Date.now() });
      pushTimeline('Discovery', 'New Test File', rel, 'info');
    });
  }

  function spawnTestRun(pattern) {
    broadcast('log',     { type: 'system', message: `── Test run starting on ${targetDir} ──`, ts: Date.now() });
    broadcast('status',  { agent: 'A', status: 'running' });
    broadcast('status',  { agent: 'B', status: 'running' });
    pushTimeline('Scan', 'Test run triggered', targetDir, 'info');

    const { output, exitCode } = runTests(targetDir, discovered.testRunner, pattern, 120_000);

    const lines = output.split('\n');
    let passCount = 0, failCount = 0;
    for (const raw of lines) {
      const line = raw.replace(/\x1B\[[0-9;]*m/g, '').trim();
      if (!line) continue;
      const cl = classifyTestLine(line);
      broadcast('log', { type: cl.type, message: cl.message, ts: Date.now() });
      if (cl.type === 'pass') passCount++;
      if (cl.type === 'fail') failCount++;
    }

    const success  = exitCode === 0;
    const total    = passCount + failCount || 1;
    const passRate = Math.round((passCount / total) * 100);
    broadcast('score', { fuzz: passRate, concur: Math.max(0, passRate - 15), patch: success ? 95 : passRate });
    broadcast('status', { agent: 'A', status: success ? 'done' : 'error' });
    broadcast('status', { agent: 'B', status: success ? 'done' : 'error' });
    pushTimeline('Result', success ? 'Tests Passed' : 'Tests Failed', `${passCount}P/${failCount}F`, success ? 'success' : 'critical');
  }

  // ── Static files + SPA fallback (MUST come after all API routes) ─────────────
  if (DIST) {
    // Serve static assets (JS, CSS, images) — these have real file paths like /assets/...
    app.use(express.static(DIST, { index: false })); // index:false = don't auto-serve index.html

    // SPA fallback: any unmatched GET returns index.html so React Router handles it
    app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
  } else {
    // No UI built — serve a plain text status page
    app.get('*', (_req, res) => {
      res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>BreakPoint AI</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:60px auto;padding:0 20px;color:#1f2328}
code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:.9em}
pre{background:#f7f8fa;padding:12px;border-radius:4px;overflow-x:auto}</style>
</head><body>
<h2>BreakPoint AI — Dashboard is running</h2>
<p><strong>Target:</strong> <code>${targetDir}</code></p>
<p>The React UI has not been built yet. The REST API and SSE streams are fully functional.</p>
<h3>API endpoints</h3>
<ul>
  <li><code>GET  /api/radar</code></li>
  <li><code>GET  /api/timeline</code></li>
  <li><code>GET  /api/target</code></li>
  <li><code>GET  /events</code> (SSE)</li>
  <li><code>GET  /events/fuzzer</code> (SSE)</li>
  <li><code>POST /run-tests</code></li>
</ul>
<h3>Build the UI</h3>
<pre><code>cd dashboard/client &amp;&amp; npm install &amp;&amp; npm run build</code></pre>
</body></html>`);
    });
  }

  // ── Start ─────────────────────────────────────────────────────────────────────
  app.listen(port, () => {
    console.log(`\n  BreakPoint AI — Dashboard`);
    console.log(`  http://localhost:${port}`);
    console.log(`  Target: ${targetDir}`);
    console.log(`  Runner: ${discovered.testRunner}\n`);
  });
};

// ── Classifier ────────────────────────────────────────────────────────────────
function classifyTestLine(line) {
  if (/✓|✔|PASS|passed/i.test(line))                 return { type: 'pass',    message: line };
  if (/✕|✗|✘|FAIL|failed|Error|throw/i.test(line))  return { type: 'fail',    message: line };
  if (/warn|deprecat/i.test(line))                    return { type: 'warn',    message: line };
  if (/payload|fuzz|inject|null|negativ/i.test(line)) return { type: 'payload', message: line };
  if (/patch|validat|lock|fix/i.test(line))           return { type: 'patch',   message: line };
  return { type: 'info', message: line };
}
