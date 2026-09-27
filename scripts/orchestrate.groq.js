#!/usr/bin/env node
/**
 * BreakPoint AI — Red Team / Blue Team / Judge Orchestrator (Groq Edition)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_ROUNDS    = parseInt(process.env.MAX_ROUNDS  || '5', 10);
const DEMO_APP_DIR  = path.resolve(
  process.env.DEMO_APP_PATH ||
  path.join(__dirname, '..', 'demo-app')
);
const REPORT_DIR    = path.join(__dirname, '..', 'audit-reports');
// Change these to match your actual SIH 2026 Python files:
const ROUTE_FILE    = path.join(DEMO_APP_DIR, 'app.py');
const OPENAPI_FILE  = path.join(DEMO_APP_DIR, 'requirements.txt'); // Or your actual API spec

// ---------------------------------------------------------------------------
// Groq API Chat Completion
// ---------------------------------------------------------------------------

async function chat(systemPrompt, userMessage) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY environment variable is not set.');

  const endpoint = process.env.API_URL || 'https://api.groq.com/openai/v1/chat/completions';
  const model = process.env.MODEL_ID || 'llama3-70b-8192';

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  }
      ],
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error (${resp.status}): ${text}`);
  }

  const json = await resp.json();
  return json.choices[0].message.content;
}

// ---------------------------------------------------------------------------
// JSON extraction — parse the last valid JSON object in an LLM response
// ---------------------------------------------------------------------------

function extractJSON(text) {
  const last = text.lastIndexOf('}');
  if (last === -1) throw new Error('No JSON object found in response');

  let depth = 0;
  let start = -1;
  for (let i = last; i >= 0; i--) {
    if (text[i] === '}') depth++;
    if (text[i] === '{') {
      depth--;
      if (depth === 0) { start = i; break; }
    }
  }
  if (start === -1) throw new Error('Unbalanced JSON in response');

  try {
    return JSON.parse(text.slice(start, last + 1));
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}\n---\n${text.slice(start, last + 1)}`);
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function readFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '(file not found)';
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// npm test runner
// ---------------------------------------------------------------------------

function runTests() {
  log('  ↳ Running npm test in ' + DEMO_APP_DIR);
  const result = spawnSync('npm', ['test', '--', '--forceExit'], {
    cwd: DEMO_APP_DIR,
    encoding: 'utf8',
    timeout: 120_000,
    shell: true,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  log('  ↳ Test run complete (exit code ' + (result.status ?? 'null') + ')');
  return { output, exitCode: result.status ?? 1 };
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function banner(title) {
  const line = '─'.repeat(60);
  console.log('\n' + line);
  console.log(`  ${title}`);
  console.log(line);
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const RED_TEAM_SYSTEM = `
You are an elite, adversarial Red Team security engineer. Your sole purpose
is to break the target API. You have no interest in fixing anything — you
exist to discover and prove vulnerabilities.

TARGET: POST /api/v1/transfer

YOUR TASK:
Analyse the provided route source and OpenAPI spec.
Then, produce a structured ATTACK REPORT representing what tests you would
run and what vulnerabilities you observe directly from the source code.
Identify every input boundary, type assumption, concurrency window, and
business-logic gap.

Output ONLY the following JSON (no prose before or after):

{
  "agent": "RED_TEAM",
  "round": <integer>,
  "totalTests": <number of test cases you specify>,
  "passing": <number you predict would pass already>,
  "failing": <number you predict would fail / expose a bug>,
  "testSuite": {
    "fuzzingTests": [
      { "name": "<test name>", "payload": <json object>, "expectedStatus": <number> }
    ],
    "concurrencyTests": [
      { "name": "<test name>", "concurrent": <number>, "payload": <json object>, "expectExactlyOneSuccess": <bool> }
    ]
  },
  "vulnerabilities": [
    {
      "id": "VULN-<n>",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "description": "<one-sentence description>",
      "payload": "<exact payload that exposes it>",
      "httpStatus": <status code actually or likely returned>,
      "expectedStatus": <correct status code>
    }
  ],
  "rawTestOutput": "<paste first 4000 chars of npm test output here, or NONE if not run>"
}
`.trim();

const BLUE_TEAM_SYSTEM = `
You are a defensive Blue Team security engineer. You write the minimum
surgical patch required to close every vulnerability the Red Team found.
You do not rewrite the whole codebase. You do not add features.

You will be given the Red Team ATTACK REPORT and the current route source.

For each vulnerability, identify the exact lines responsible and write the
minimal guard that closes the vector. Then produce a PATCH REPORT.

Output ONLY the following JSON (no prose before or after):

{
  "agent": "BLUE_TEAM",
  "round": <same integer as Red Team round>,
  "patchesApplied": <count>,
  "patches": [
    {
      "vulnId":   "<VULN-n>",
      "location": "<line range or function>",
      "strategy": "<one-sentence defence description>",
      "codeDiff": "<the exact lines added or changed>"
    }
  ],
  "updatedRouteSource": "<complete updated content of routes/transfer.js — ALL lines>",
  "notes": "<caveats or residual concerns>"
}
`.trim();

const JUDGE_SYSTEM = `
You are an impartial security audit Judge. You hold veto power over the loop.

You will be given the Red Team ATTACK REPORT, the Blue Team PATCH REPORT,
and a history array of previous round summaries.

Cross-reference every VULN-n in the attack report against the patch report.
Assess whether each patch genuinely closes the vector. Identify any attack
classes not tested that remain obviously open.

Output ONLY the following JSON (no prose before or after):

{
  "agent": "JUDGE",
  "round": <same integer>,
  "verdict": "APPROVED" | "REJECTED",
  "score": <0–100 security posture score>,
  "approvedVulns": ["<VULN-n>", ...],
  "rejectedVulns": [
    {
      "vulnId": "<VULN-n>",
      "reason": "<why patch is insufficient>",
      "suggestedStrategy": "<hint for Blue Team>"
    }
  ],
  "newConcerns": ["<attack class not yet tested>"],
  "summary": "<2–3 sentence plain-English verdict>"
}
`.trim();

// ---------------------------------------------------------------------------
// Agent invocations
// ---------------------------------------------------------------------------

async function invokeRedTeam(round, routeSource, openapiSource) {
  banner(`ROUND ${round} — RED TEAM`);
  const userMsg = [
    `Round: ${round}`,
    '',
    '=== routes/transfer.js ===',
    routeSource,
    '',
    '=== openapi.json ===',
    openapiSource,
  ].join('\n');

  const response = await chat(RED_TEAM_SYSTEM, userMsg);
  log('  ↳ Red Team response received');
  return extractJSON(response);
}

async function invokeBlueTeam(round, attackReport, routeSource) {
  banner(`ROUND ${round} — BLUE TEAM`);
  const userMsg = [
    `Round: ${round}`,
    '',
    '=== ATTACK REPORT ===',
    JSON.stringify(attackReport, null, 2),
    '',
    '=== Current routes/transfer.js ===',
    routeSource,
  ].join('\n');

  const response = await chat(BLUE_TEAM_SYSTEM, userMsg);
  log('  ↳ Blue Team response received');
  return extractJSON(response);
}

async function invokeJudge(round, attackReport, patchReport, history) {
  banner(`ROUND ${round} — JUDGE`);
  const userMsg = [
    `Round: ${round}`,
    '',
    '=== ATTACK REPORT ===',
    JSON.stringify(attackReport, null, 2),
    '',
    '=== PATCH REPORT ===',
    JSON.stringify(patchReport, null, 2),
    '',
    '=== HISTORY (previous rounds) ===',
    JSON.stringify(history, null, 2),
  ].join('\n');

  const response = await chat(JUDGE_SYSTEM, userMsg);
  log('  ↳ Judge response received');
  return extractJSON(response);
}

// ---------------------------------------------------------------------------
// Apply Blue Team patch
// ---------------------------------------------------------------------------

function applyPatch(patchReport) {
  const src = patchReport.updatedRouteSource;
  if (!src || typeof src !== 'string' || src.trim().length < 20) {
    log('  ↳ WARNING: Blue Team did not provide updatedRouteSource — skipping file write');
    return;
  }
  writeFileAtomic(ROUTE_FILE, src);
  log(`  ↳ Patch applied → ${ROUTE_FILE}`);
}

// ---------------------------------------------------------------------------
// Persist round reports
// ---------------------------------------------------------------------------

function saveReport(round, attackReport, patchReport, judgeVerdict) {
  ensureDir(REPORT_DIR);
  const file = path.join(REPORT_DIR, `round-${round}.json`);
  const report = { round, timestamp: new Date().toISOString(), attackReport, patchReport, judgeVerdict };
  writeFileAtomic(file, JSON.stringify(report, null, 2));
  log(`  ↳ Report saved → ${file}`);
  return report;
}

function saveFinalReport(rounds, approved) {
  ensureDir(REPORT_DIR);
  const file = path.join(REPORT_DIR, 'final-audit.json');
  const final = { approved, totalRounds: rounds.length, timestamp: new Date().toISOString(), rounds };
  writeFileAtomic(file, JSON.stringify(final, null, 2));
  log(`\n  ↳ Final audit report → ${file}`);
}

// ---------------------------------------------------------------------------
// Main orchestration loop
// ---------------------------------------------------------------------------

async function main() {
  banner('BreakPoint AI — Orchestrator Starting (Groq Edition)');
  log(`Demo app: ${DEMO_APP_DIR}`);
  log(`Model:    ${process.env.MODEL_ID || 'llama3-70b-8192'}`);
  log(`Max rounds: ${MAX_ROUNDS}`);

  if (!process.env.GROQ_API_KEY) {
    console.error('\n[ERROR] GROQ_API_KEY is not set. Export it and retry.\n');
    process.exit(1);
  }

  const history = [];
  const allRounds = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    log(`\n════ Starting Round ${round} of ${MAX_ROUNDS} ════`);

    const routeSource   = readFile(ROUTE_FILE);
    const openapiSource = readFile(OPENAPI_FILE);

    // ── Step 1: Red Team ────────────────────────────────────────────────────
    let attackReport;
    try {
      attackReport = await invokeRedTeam(round, routeSource, openapiSource);
      attackReport.round = round;
      log(`  Vulnerabilities found: ${(attackReport.vulnerabilities || []).length}`);
    } catch (err) {
      log(`  [ERROR] Red Team invocation failed: ${err.message}`);
      log('  Aborting round — will retry next round');
      continue;
    }

    // ── Step 2: Blue Team ───────────────────────────────────────────────────
    let patchReport;
    try {
      patchReport = await invokeBlueTeam(round, attackReport, routeSource);
      patchReport.round = round;
      log(`  Patches applied: ${patchReport.patchesApplied ?? 0}`);
    } catch (err) {
      log(`  [ERROR] Blue Team invocation failed: ${err.message}`);
      log('  Continuing to Judge with empty patch report');
      patchReport = { agent: 'BLUE_TEAM', round, patchesApplied: 0, patches: [], notes: `Error: ${err.message}` };
    }

    applyPatch(patchReport);

    // ── Step 3: Run the actual test suite ───────────────────────────────────
    const { output: testOutput, exitCode } = runTests();
    attackReport.rawTestOutput = testOutput.slice(0, 4000);
    attackReport.testExitCode  = exitCode;

    // ── Step 4: Judge ───────────────────────────────────────────────────────
    let judgeVerdict;
    try {
      judgeVerdict = await invokeJudge(round, attackReport, patchReport, history);
      judgeVerdict.round = round;
    } catch (err) {
      log(`  [ERROR] Judge invocation failed: ${err.message}`);
      judgeVerdict = {
        agent: 'JUDGE', round, verdict: 'REJECTED', score: 0,
        approvedVulns: [], rejectedVulns: [], newConcerns: [],
        summary: `Judge error: ${err.message}`,
      };
    }

    const roundData = saveReport(round, attackReport, patchReport, judgeVerdict);
    allRounds.push(roundData);

    history.push({
      round,
      score: judgeVerdict.score,
      verdict: judgeVerdict.verdict,
      vulnCount: (attackReport.vulnerabilities || []).length,
      patchCount: patchReport.patchesApplied ?? 0,
      testExitCode: exitCode,
    });

    banner(`ROUND ${round} VERDICT: ${judgeVerdict.verdict}  (score: ${judgeVerdict.score}/100)`);
    log(judgeVerdict.summary || '');

    if (judgeVerdict.verdict === 'APPROVED') {
      log('\n✅  APPROVED — all vulnerabilities resolved. Exiting cleanly.\n');
      saveFinalReport(allRounds, true);
      process.exit(0);
    }

    if (round < MAX_ROUNDS) {
      log(`\n🔄  REJECTED — proceeding to round ${round + 1}...\n`);
    }
  }

  banner('AUDIT FAILED — MAX ROUNDS REACHED');
  log(`❌  The route was NOT approved after ${MAX_ROUNDS} rounds.\n`);
  saveFinalReport(allRounds, false);
  process.exit(1);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(2);
});