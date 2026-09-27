#!/usr/bin/env node
/**
 * BreakPoint AI — Red Team / Blue Team / Judge Orchestrator
 *
 * Drives the adversarial loop:
 *   Round N:
 *     1. Red Team  → runs npm test, emits ATTACK REPORT JSON
 *     2. Blue Team → patches routes/transfer.js, emits PATCH REPORT JSON
 *     3. Judge     → evaluates both reports, emits JUDGE VERDICT JSON
 *     4. If verdict === "APPROVED"  → exit 0
 *        If verdict === "REJECTED"  → next round (max MAX_ROUNDS)
 *
 * Prerequisites:
 *   - Node.js 18+ (uses native fetch)
 *   - WATSONX_API_KEY env var  (IBM watsonx.ai API key)
 *   - WATSONX_PROJECT_ID env var
 *   - WATSONX_URL env var (default: https://us-south.ml.cloud.ibm.com)
 *   - MODEL_ID env var (default: ibm/granite-3-3-8b-instruct)
 *
 * Usage:
 *   node orchestrate.js [--rounds <n>] [--demo-app <path>]
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_ROUNDS    = parseInt(process.env.MAX_ROUNDS  || '5', 10);
const DEMO_APP_DIR  = path.resolve(
  process.env.DEMO_APP_PATH ||
  path.join(__dirname, '..', 'demo-app')
);
const REPORT_DIR    = path.join(__dirname, '..', 'audit-reports');
const ROUTE_FILE    = path.join(DEMO_APP_DIR, 'routes', 'transfer.js');
const OPENAPI_FILE  = path.join(DEMO_APP_DIR, 'openapi.json');
const FUZZING_FILE  = path.join(DEMO_APP_DIR, 'tests', 'generated_fuzzing.test.js');
const CONCURRENCY_FILE = path.join(DEMO_APP_DIR, 'tests', 'generated_concurrency.test.js');

const WATSONX_URL      = process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com';
const WATSONX_API_KEY  = process.env.WATSONX_API_KEY;
const WATSONX_PROJECT  = process.env.WATSONX_PROJECT_ID;
const MODEL_ID         = process.env.MODEL_ID || 'meta-llama/llama-3-3-70b-instruct';

const IAM_TOKEN_URL = 'https://iam.cloud.ibm.com/identity/token';

// ---------------------------------------------------------------------------
// IAM token cache
// ---------------------------------------------------------------------------

let _iamToken = null;
let _iamExpiry = 0;

async function getIAMToken() {
  if (_iamToken && Date.now() < _iamExpiry) return _iamToken;

  if (!WATSONX_API_KEY) {
    throw new Error('WATSONX_API_KEY environment variable is not set.');
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
    apikey: WATSONX_API_KEY,
  });

  const resp = await fetch(IAM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`IAM token request failed (${resp.status}): ${text}`);
  }

  const json = await resp.json();
  _iamToken  = json.access_token;
  // Expire 5 minutes before the token actually expires
  _iamExpiry = Date.now() + (json.expires_in - 300) * 1000;
  return _iamToken;
}

// ---------------------------------------------------------------------------
// watsonx.ai chat completion
// ---------------------------------------------------------------------------

async function chat(systemPrompt, userMessage) {
  if (!WATSONX_PROJECT) {
    throw new Error('WATSONX_PROJECT_ID environment variable is not set.');
  }

  const token = await getIAMToken();

  const endpoint = `${WATSONX_URL}/ml/v1/text/chat?version=2024-05-31`;

  const payload = {
    model_id: MODEL_ID,
    project_id: WATSONX_PROJECT,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  },
    ],
    parameters: {
      max_new_tokens: 4096,
      temperature: 0.2,
    },
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`watsonx API error (${resp.status}): ${text}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content ?? json.results?.[0]?.generated_text ?? '';
}

// ---------------------------------------------------------------------------
// JSON extraction — parse the last valid JSON object in an LLM response
// ---------------------------------------------------------------------------

function extractJSON(text) {
  // Walk backwards looking for the last {...} block
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
// System prompts (inline, mirrors redteam-orchestrator.md)
// ---------------------------------------------------------------------------

const RED_TEAM_SYSTEM = `
You are an elite, adversarial Red Team security engineer. Your sole purpose
is to break the target API. You have no interest in fixing anything — you
exist to discover and prove vulnerabilities.

TARGET: POST /api/v1/transfer  (Express.js route in demo-app/routes/transfer.js)

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
// Apply Blue Team patch: write the updated route source to disk
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
  const report = {
    round,
    timestamp: new Date().toISOString(),
    attackReport,
    patchReport,
    judgeVerdict,
  };
  writeFileAtomic(file, JSON.stringify(report, null, 2));
  log(`  ↳ Report saved → ${file}`);
  return report;
}

function saveFinalReport(rounds, approved) {
  ensureDir(REPORT_DIR);
  const file = path.join(REPORT_DIR, 'final-audit.json');
  const final = {
    approved,
    totalRounds: rounds.length,
    timestamp: new Date().toISOString(),
    rounds,
  };
  writeFileAtomic(file, JSON.stringify(final, null, 2));
  log(`\n  ↳ Final audit report → ${file}`);
}

// ---------------------------------------------------------------------------
// Main orchestration loop
// ---------------------------------------------------------------------------

async function main() {
  banner('BreakPoint AI — Orchestrator Starting');
  log(`Demo app: ${DEMO_APP_DIR}`);
  log(`Model:    ${MODEL_ID}`);
  log(`Max rounds: ${MAX_ROUNDS}`);

  if (!WATSONX_API_KEY) {
    console.error('\n[ERROR] WATSONX_API_KEY is not set. Export it and retry.\n');
    process.exit(1);
  }
  if (!WATSONX_PROJECT) {
    console.error('\n[ERROR] WATSONX_PROJECT_ID is not set. Export it and retry.\n');
    process.exit(1);
  }

  const history = [];
  const allRounds = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    log(`\n════ Starting Round ${round} of ${MAX_ROUNDS} ════`);

    // Read current state from disk before each round
    const routeSource   = readFile(ROUTE_FILE);
    const openapiSource = readFile(OPENAPI_FILE);

    // ── Step 1: Red Team ────────────────────────────────────────────────────
    let attackReport;
    try {
      attackReport = await invokeRedTeam(round, routeSource, openapiSource);
      attackReport.round = round; // normalise
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

    // Write the patched route to disk
    applyPatch(patchReport);

    // ── Step 3: Run the actual test suite against the patched code ──────────
    const { output: testOutput, exitCode } = runTests();
    // Attach real test output to the attack report for Judge context
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
        agent: 'JUDGE', round,
        verdict: 'REJECTED',
        score: 0,
        approvedVulns: [],
        rejectedVulns: [],
        newConcerns: [],
        summary: `Judge error: ${err.message}`,
      };
    }

    // Persist round artifacts
    const roundData = saveReport(round, attackReport, patchReport, judgeVerdict);
    allRounds.push(roundData);

    // Record a compact summary for Judge history
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

  // Exhausted all rounds without approval
  banner('AUDIT FAILED — MAX ROUNDS REACHED');
  log(`❌  The route was NOT approved after ${MAX_ROUNDS} rounds.\n`);
  saveFinalReport(allRounds, false);
  process.exit(1);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(2);
});
