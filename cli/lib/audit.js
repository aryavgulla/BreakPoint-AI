'use strict';
/**
 * lib/audit.js
 *
 * The Red Team → Blue Team → Judge loop.
 * Works against any project directory — no hardcoded paths.
 *
 * Entry point:  module.exports = async function audit(targetDir, options)
 *
 * targetDir  — absolute path to the project being audited
 * options    — { rounds, model, outputDir, verbose }
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const scan  = require('./scan');
const { detectTestRunner, runTests } = require('./run-tests-lib');
const { discoverEntryFiles }         = require('./discover');

// ── watsonx wiring ─────────────────────────────────────────────────────────────
const WATSONX_URL   = process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com';
const IAM_TOKEN_URL = 'https://iam.cloud.ibm.com/identity/token';

let _iamToken  = null;
let _iamExpiry = 0;

async function getIAMToken() {
  if (_iamToken && Date.now() < _iamExpiry) return _iamToken;

  const key = process.env.WATSONX_API_KEY;
  if (!key) throw new Error('WATSONX_API_KEY environment variable is not set.');

  const body = new URLSearchParams({
    grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
    apikey: key,
  });

  const resp = await fetch(IAM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`IAM token request failed (${resp.status}): ${await resp.text()}`);

  const json  = await resp.json();
  _iamToken   = json.access_token;
  _iamExpiry  = Date.now() + (json.expires_in - 300) * 1000;
  return _iamToken;
}

async function chat(modelId, projectId, systemPrompt, userMessage) {
  if (!projectId) throw new Error('WATSONX_PROJECT_ID environment variable is not set.');

  const token    = await getIAMToken();
  const endpoint = `${WATSONX_URL}/ml/v1/text/chat?version=2024-05-31`;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model_id:   modelId,
      project_id: projectId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
      parameters: { max_new_tokens: 4096, temperature: 0.2 },
    }),
  });

  if (!resp.ok) throw new Error(`watsonx API error (${resp.status}): ${await resp.text()}`);

  const json = await resp.json();
  return json.choices?.[0]?.message?.content ?? json.results?.[0]?.generated_text ?? '';
}

// ── JSON extraction ────────────────────────────────────────────────────────────
function extractJSON(text) {
  const last = text.lastIndexOf('}');
  if (last === -1) throw new Error('No JSON object found in LLM response');

  let depth = 0, start = -1;
  for (let i = last; i >= 0; i--) {
    if (text[i] === '}') depth++;
    if (text[i] === '{') { depth--; if (depth === 0) { start = i; break; } }
  }
  if (start === -1) throw new Error('Unbalanced JSON in LLM response');

  try {
    return JSON.parse(text.slice(start, last + 1));
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}\n---\n${text.slice(start, last + 1).slice(0, 500)}`);
  }
}

// ── Logging ────────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function banner(title) {
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

// ── System prompts ─────────────────────────────────────────────────────────────
// Generic — work on any codebase, not hardcoded to /routes/transfer.js

const RED_TEAM_SYSTEM = `
You are an elite adversarial Red Team security engineer. Your job is to find
every exploitable vulnerability in the target source code.

You will receive:
  - The contents of one or more source files from the target project.
  - A static analysis pre-scan report (may be empty).
  - (Optional) An API spec if one exists in the project.

YOUR TASK:
  Analyse every input boundary, type assumption, authentication gap, injection
  surface, concurrency window, and business-logic flaw you can find.

Output ONLY valid JSON in this exact shape (no prose before or after):

{
  "agent": "RED_TEAM",
  "round": <integer>,
  "totalTests": <number of test cases you specify>,
  "passing": <number you predict currently pass>,
  "failing": <number you predict currently fail>,
  "testSuite": {
    "fuzzingTests": [
      { "name": "<test name>", "description": "<what this tests>", "payload": "<attack payload or scenario>", "expectedBehaviour": "<what a secure app should do>" }
    ],
    "concurrencyTests": [
      { "name": "<test name>", "description": "<race condition scenario>", "concurrent": <number of parallel requests>, "expectExactlyOneSuccess": <bool> }
    ]
  },
  "vulnerabilities": [
    {
      "id": "VULN-<n>",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "file": "<file path>",
      "line": <line number or 0 if unknown>,
      "description": "<one-sentence description>",
      "payload": "<exact input or scenario that exposes it>",
      "currentBehaviour": "<what the code currently does wrong>",
      "expectedBehaviour": "<what it should do>"
    }
  ]
}
`.trim();

const BLUE_TEAM_SYSTEM = `
You are a defensive Blue Team security engineer. You write the minimum surgical
patch required to close every vulnerability the Red Team found. You do not
rewrite the codebase. You do not add features.

You will receive:
  - The Red Team ATTACK REPORT JSON.
  - The current source of each affected file.

For each vulnerability, identify the exact lines responsible and write the
minimal guard that closes that specific vector.

Output ONLY valid JSON in this exact shape (no prose before or after):

{
  "agent": "BLUE_TEAM",
  "round": <same integer as Red Team round>,
  "patchesApplied": <count>,
  "patches": [
    {
      "vulnId":    "<VULN-n>",
      "file":      "<relative file path>",
      "location":  "<function name or line range>",
      "strategy":  "<one-sentence defence description>",
      "codeDiff":  "<the exact lines added or changed>"
    }
  ],
  "updatedFiles": {
    "<relative file path>": "<complete updated file content>"
  },
  "notes": "<caveats or residual concerns>"
}
`.trim();

const JUDGE_SYSTEM = `
You are an impartial security audit Judge. You hold veto power over the loop.

You will receive:
  - The Red Team ATTACK REPORT JSON.
  - The Blue Team PATCH REPORT JSON.
  - History of previous rounds.

Cross-reference every VULN-n against the patch report. Assess patch quality.
If the same vulnerability reappears across rounds, escalate its severity.

Output ONLY valid JSON in this exact shape (no prose before or after):

{
  "agent": "JUDGE",
  "round": <same integer>,
  "verdict": "APPROVED" | "REJECTED",
  "score": <integer 0-100>,
  "approvedVulns": ["<VULN-n>", ...],
  "rejectedVulns": [
    {
      "vulnId": "<VULN-n>",
      "reason": "<why the patch is insufficient>",
      "suggestedStrategy": "<one-sentence hint for Blue Team>"
    }
  ],
  "newConcerns": ["<attack class not yet tested>"],
  "summary": "<2-3 sentence plain-English verdict>"
}
`.trim();

// ── File helpers ───────────────────────────────────────────────────────────────
function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return '(unreadable)'; }
}

function writeFileSafe(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

// ── Main export ────────────────────────────────────────────────────────────────
module.exports = async function audit(targetDir, options = {}) {
  const {
    rounds    = 5,
    model     = process.env.MODEL_ID || 'ibm/granite-3-3-8b-instruct',
    outputDir = path.join(targetDir, '.breakpoint', 'audit-reports'),
    verbose   = false,
  } = options;

  const projectId = process.env.WATSONX_PROJECT_ID;

  banner('BreakPoint AI — Security Audit Starting');
  log(`Target:     ${targetDir}`);
  log(`Model:      ${model}`);
  log(`Max rounds: ${rounds}`);
  log(`Reports:    ${outputDir}`);

  if (!process.env.WATSONX_API_KEY) {
    console.error('\n[ERROR] WATSONX_API_KEY is not set. Export it and retry.\n');
    process.exit(1);
  }
  if (!projectId) {
    console.error('\n[ERROR] WATSONX_PROJECT_ID is not set. Export it and retry.\n');
    process.exit(1);
  }

  // ── 1. Discover what's in the project ───────────────────────────────────────
  log('Discovering project structure...');
  const discovered = discoverEntryFiles(targetDir);
  log(`  Source files found: ${discovered.sourceFiles.length}`);
  log(`  Test runner:        ${discovered.testRunner}`);
  if (discovered.specFile) log(`  API spec:           ${discovered.specFile}`);

  // ── 2. Static pre-scan ──────────────────────────────────────────────────────
  log('Running static pre-scan...');
  const staticFindings = await runStaticScan(targetDir, discovered.sourceFiles);
  log(`  Static findings: ${staticFindings.total_findings} (${staticFindings.by_severity.critical} critical, ${staticFindings.by_severity.high} high)`);

  // ── 3. Build source context for LLM ─────────────────────────────────────────
  // staticFindings passed so priority files (those with findings) are shown first
  const sourceContext = buildSourceContext(targetDir, discovered.sourceFiles, staticFindings);
  const specContext   = discovered.specFile
    ? `\n=== API Spec (${path.basename(discovered.specFile)}) ===\n${readFileSafe(discovered.specFile)}`
    : '';

  // ── 4. Red/Blue/Judge loop ───────────────────────────────────────────────────
  fs.mkdirSync(outputDir, { recursive: true });

  const history   = [];
  const allRounds = [];

  for (let round = 1; round <= rounds; round++) {
    log(`\n════ Starting Round ${round} of ${rounds} ════`);

    // Rebuild source context each round (Blue Team may have patched files)
    const currentSource = buildSourceContext(targetDir, discovered.sourceFiles, staticFindings);

    // ── RED TEAM ──
    banner(`ROUND ${round} — RED TEAM`);
    let attackReport;
    try {
      const userMsg = [
        `Round: ${round}`,
        '',
        '=== Static Analysis Pre-Scan ===',
        JSON.stringify(staticFindings, null, 2),
        '',
        currentSource,
        specContext,
      ].join('\n');

      const raw = await chat(model, projectId, RED_TEAM_SYSTEM, userMsg);
      if (verbose) log('  Raw Red Team response length: ' + raw.length);
      attackReport       = extractJSON(raw);
      attackReport.round = round;
      log(`  Vulnerabilities found: ${(attackReport.vulnerabilities || []).length}`);
    } catch (err) {
      log(`  [ERROR] Red Team failed: ${err.message}`);
      continue;
    }

    // ── BLUE TEAM ──
    banner(`ROUND ${round} — BLUE TEAM`);
    let patchReport;
    try {
      const affectedFiles = getAffectedFiles(targetDir, attackReport, discovered.sourceFiles);
      const userMsg = [
        `Round: ${round}`,
        '',
        '=== ATTACK REPORT ===',
        JSON.stringify(attackReport, null, 2),
        '',
        affectedFiles,
      ].join('\n');

      const raw = await chat(model, projectId, BLUE_TEAM_SYSTEM, userMsg);
      if (verbose) log('  Raw Blue Team response length: ' + raw.length);
      patchReport       = extractJSON(raw);
      patchReport.round = round;
      log(`  Patches applied: ${patchReport.patchesApplied ?? 0}`);
    } catch (err) {
      log(`  [ERROR] Blue Team failed: ${err.message}`);
      patchReport = { agent: 'BLUE_TEAM', round, patchesApplied: 0, patches: [], notes: `Error: ${err.message}`, updatedFiles: {} };
    }

    // Write patched files to disk
    applyPatches(targetDir, patchReport, verbose);

    // ── RUN ACTUAL TESTS ──
    log('  Running tests against patched code...');
    const { output: testOutput, exitCode } = runTests(targetDir, discovered.testRunner, null, 120_000);
    attackReport.rawTestOutput = testOutput.slice(0, 4000);
    attackReport.testExitCode  = exitCode;
    log(`  Test exit code: ${exitCode}`);

    // ── JUDGE ──
    banner(`ROUND ${round} — JUDGE`);
    let judgeVerdict;
    try {
      const userMsg = [
        `Round: ${round}`,
        '',
        '=== ATTACK REPORT ===',
        JSON.stringify(attackReport, null, 2),
        '',
        '=== PATCH REPORT ===',
        JSON.stringify(patchReport, null, 2),
        '',
        '=== HISTORY ===',
        JSON.stringify(history, null, 2),
      ].join('\n');

      const raw = await chat(model, projectId, JUDGE_SYSTEM, userMsg);
      if (verbose) log('  Raw Judge response length: ' + raw.length);
      judgeVerdict       = extractJSON(raw);
      judgeVerdict.round = round;
    } catch (err) {
      log(`  [ERROR] Judge failed: ${err.message}`);
      judgeVerdict = {
        agent: 'JUDGE', round, verdict: 'REJECTED', score: 0,
        approvedVulns: [], rejectedVulns: [], newConcerns: [],
        summary: `Judge error: ${err.message}`,
      };
    }

    // Save round report
    const roundData = {
      round,
      timestamp:    new Date().toISOString(),
      attackReport,
      patchReport,
      judgeVerdict,
    };
    writeFileSafe(path.join(outputDir, `round-${round}.json`), JSON.stringify(roundData, null, 2));
    allRounds.push(roundData);

    history.push({
      round,
      score:       judgeVerdict.score,
      verdict:     judgeVerdict.verdict,
      vulnCount:   (attackReport.vulnerabilities || []).length,
      patchCount:  patchReport.patchesApplied ?? 0,
      testExitCode: exitCode,
    });

    banner(`ROUND ${round} VERDICT: ${judgeVerdict.verdict}  (score: ${judgeVerdict.score}/100)`);
    log(judgeVerdict.summary || '');

    if (judgeVerdict.verdict === 'APPROVED') {
      log('\n✅  APPROVED — all vulnerabilities resolved.\n');
      saveFinalReport(outputDir, allRounds, true);
      process.exit(0);
    }

    if (round < rounds) log(`\n🔄  REJECTED — proceeding to round ${round + 1}...\n`);
  }

  banner('AUDIT FAILED — MAX ROUNDS REACHED');
  log(`❌  Not approved after ${rounds} rounds.\n`);
  saveFinalReport(outputDir, allRounds, false);
  process.exit(1);
};

// ── Helpers ────────────────────────────────────────────────────────────────────

// How many characters of source to include per LLM call.
// Granite-3-3-8b has ~8192 token context; ~3 chars/token → ~24K chars safe budget.
// We reserve ~8K for the system prompt + JSON output, leaving ~16K for source.
const SOURCE_BUDGET_CHARS = 16_000;

// How many chars to include per individual file (prevents one huge file consuming all budget)
const MAX_CHARS_PER_FILE  = 6_000;

// How many lines of context to extract around each finding for the Blue Team
const LINES_OF_CONTEXT = 20;

/**
 * Builds a source context string that fits within SOURCE_BUDGET_CHARS.
 *
 * Strategy for large projects:
 *   1. Skip test files, minified files, lock files.
 *   2. Prefer files that already have static findings (they're most relevant).
 *   3. Truncate each file to MAX_CHARS_PER_FILE to prevent one file consuming all budget.
 *   4. Stop adding files once the budget is hit.
 *   5. Include a file index at the top so the model knows what exists even if not shown.
 */
function buildSourceContext(targetDir, sourceFiles, staticFindings) {
  // Deduplicate file list into relevant (non-test) source files
  const isTestFile = f =>
    /[/\\]tests?[/\\]/.test(f) ||
    f.endsWith('.test.js')  || f.endsWith('.test.ts') ||
    f.endsWith('.spec.js')  || f.endsWith('.spec.ts') ||
    f.endsWith('_test.go')  || f.endsWith('_test.py');

  const relevant = sourceFiles.filter(f => !isTestFile(f));

  // Score files: ones with findings first, then by size ascending
  const findingFiles = new Set(
    (staticFindings && staticFindings.findings || []).map(f => f.file)
      .map(f => path.resolve(targetDir, f))
  );

  const scored = relevant.map(f => ({
    path:    f,
    score:   findingFiles.has(f) ? 0 : 1,   // 0 = has findings (higher priority)
    size:    (() => { try { return fs.statSync(f).size; } catch { return 0; } })(),
  }))
  .sort((a, b) => a.score - b.score || a.size - b.size);

  // Build an index header (always include, doesn't count toward file budget)
  const allRels  = relevant.map(f => path.relative(targetDir, f).replace(/\\/g, '/'));
  const indexHdr = `=== PROJECT FILE INDEX (${relevant.length} source files) ===\n` +
                   allRels.join('\n') + '\n';

  // Fill budget
  const sections = [indexHdr];
  let used = indexHdr.length;

  for (const { path: f } of scored) {
    if (used >= SOURCE_BUDGET_CHARS) break;
    const rel     = path.relative(targetDir, f).replace(/\\/g, '/');
    const raw     = readFileSafe(f);
    const content = raw.length > MAX_CHARS_PER_FILE
      ? raw.slice(0, MAX_CHARS_PER_FILE) + `\n... [truncated — ${raw.length - MAX_CHARS_PER_FILE} more chars] ...`
      : raw;
    const block = `=== ${rel} ===\n${content}`;
    sections.push(block);
    used += block.length;
  }

  const skipped = scored.length - (sections.length - 1); // minus the index header
  if (skipped > 0) {
    sections.push(`\n[${skipped} additional files omitted to fit context window — full list in FILE INDEX above]`);
  }

  return sections.join('\n\n');
}

/**
 * For the Blue Team: instead of dumping full files, extract only the lines
 * around each vulnerability finding (±LINES_OF_CONTEXT lines).
 * This massively reduces message size for large files while giving the model
 * exactly what it needs to write a targeted patch.
 */
function getAffectedFiles(targetDir, attackReport, sourceFiles) {
  const vulns = attackReport.vulnerabilities || [];

  if (vulns.length === 0) {
    // No specific vulnerabilities — give the first 3 source files truncated
    return sourceFiles.slice(0, 3).map(f => {
      const rel = path.relative(targetDir, f).replace(/\\/g, '/');
      const src = readFileSafe(f);
      const content = src.length > MAX_CHARS_PER_FILE
        ? src.slice(0, MAX_CHARS_PER_FILE) + '\n... [truncated] ...'
        : src;
      return `=== ${rel} ===\n${content}`;
    }).join('\n\n');
  }

  // Group vulnerabilities by file
  const byFile = {};
  for (const v of vulns) {
    if (!v.file) continue;
    (byFile[v.file] ??= []).push(v.line || 0);
  }

  const sections = [];

  for (const [relPath, lines] of Object.entries(byFile)) {
    // Resolve the file — tolerate either forward or backslashes
    const absPath = sourceFiles.find(f => {
      const rel = path.relative(targetDir, f).replace(/\\/g, '/');
      return rel === relPath.replace(/\\/g, '/') || rel.endsWith(relPath.replace(/\\/g, '/'));
    }) || path.resolve(targetDir, relPath);

    const src = readFileSafe(absPath);
    if (src === '(unreadable)') {
      sections.push(`=== ${relPath} ===\n(file not found or unreadable)`);
      continue;
    }

    const allLines = src.split('\n');

    // If the whole file fits in budget, send it all
    if (src.length <= MAX_CHARS_PER_FILE) {
      sections.push(`=== ${relPath} (full, ${allLines.length} lines) ===\n${src}`);
      continue;
    }

    // Otherwise extract windows around each vulnerable line
    const lineSet = new Set();
    for (const ln of lines) {
      if (ln > 0) {
        const start = Math.max(0, ln - LINES_OF_CONTEXT - 1);
        const end   = Math.min(allLines.length, ln + LINES_OF_CONTEXT);
        for (let i = start; i < end; i++) lineSet.add(i);
      }
    }

    // If no line numbers, send the first MAX_CHARS_PER_FILE chars
    if (lineSet.size === 0) {
      const truncated = src.slice(0, MAX_CHARS_PER_FILE) + '\n... [truncated] ...';
      sections.push(`=== ${relPath} (truncated) ===\n${truncated}`);
      continue;
    }

    const sortedIdxs = [...lineSet].sort((a, b) => a - b);
    let excerpt = '';
    let prevIdx = -2;
    for (const idx of sortedIdxs) {
      if (idx > prevIdx + 1) excerpt += `\n... (line ${idx + 1}) ...\n`;
      excerpt += `${String(idx + 1).padStart(4)} | ${allLines[idx]}\n`;
      prevIdx = idx;
    }

    sections.push(`=== ${relPath} (excerpts around vulnerable lines) ===\n${excerpt.trim()}`);
  }

  return sections.join('\n\n');
}

function applyPatches(targetDir, patchReport, verbose) {
  const updatedFiles = patchReport.updatedFiles || {};
  for (const [relPath, content] of Object.entries(updatedFiles)) {
    if (!content || typeof content !== 'string' || content.trim().length < 10) {
      if (verbose) log(`  ↳ Skipping empty patch for ${relPath}`);
      continue;
    }
    const absPath = path.resolve(targetDir, relPath);
    // Safety: stay inside targetDir
    if (!absPath.startsWith(targetDir + path.sep) && absPath !== targetDir) {
      log(`  ↳ REJECTED patch outside target dir: ${relPath}`);
      continue;
    }
    // Backup original
    try {
      if (fs.existsSync(absPath)) {
        fs.writeFileSync(absPath + '.bak', fs.readFileSync(absPath));
      }
      writeFileSafe(absPath, content);
      log(`  ↳ Patch applied → ${relPath}`);
    } catch (err) {
      log(`  ↳ Patch failed for ${relPath}: ${err.message}`);
    }
  }
}

async function runStaticScan(targetDir, sourceFiles) {
  // Reuse the scan module but return structured data
  const { collectSourceFiles, runAstRules } = require('./scan-lib');
  const files   = sourceFiles.length > 0 ? sourceFiles : collectSourceFiles(targetDir, ['.js', '.ts']);
  const all     = [];
  for (const f of files) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      all.push(...runAstRules(f, src));
    } catch {}
  }
  return {
    total_findings: all.length,
    by_severity: {
      critical: all.filter(f => f.severity === 'critical').length,
      high:     all.filter(f => f.severity === 'high').length,
      medium:   all.filter(f => f.severity === 'medium').length,
      low:      all.filter(f => f.severity === 'low').length,
    },
    findings: all.map(f => ({
      ...f,
      file: path.relative(targetDir, f.file),
    })),
  };
}

function saveFinalReport(outputDir, rounds, approved) {
  const final = {
    approved,
    totalRounds: rounds.length,
    timestamp:   new Date().toISOString(),
    rounds,
  };
  writeFileSafe(path.join(outputDir, 'final-audit.json'), JSON.stringify(final, null, 2));
  log(`\n  Final audit report → ${outputDir}/final-audit.json`);
}
