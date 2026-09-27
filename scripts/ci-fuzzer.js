#!/usr/bin/env node
/**
 * ci-fuzzer.js — BreakPoint AI CI gate
 *
 * 1. Runs the full Jest suite (fuzzing + concurrency) inside demo-app/.
 * 2. Parses the output into a structured Merge Confidence Scorecard.
 * 3. Posts the scorecard as a PR comment via the GitHub REST API.
 * 4. Exits with code 1 if any test failed (blocks the merge).
 *
 * Required env vars (all injected by the Actions workflow):
 *   GITHUB_TOKEN          – Actions token with `pull-requests: write`
 *   GITHUB_REPOSITORY     – "owner/repo"
 *   PR_NUMBER             – pull request number
 *
 * Optional:
 *   DEMO_APP_DIR          – absolute path to demo-app/ (default: auto-resolved)
 *   TEST_TIMEOUT_MS       – Jest timeout cap in ms (default: 90000)
 */

'use strict';

const { spawnSync } = require('child_process');
const https         = require('https');
const path          = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEMO_APP_DIR   = process.env.DEMO_APP_DIR
  ?? path.resolve(__dirname, '..', 'demo-app');

const TIMEOUT_MS     = parseInt(process.env.TEST_TIMEOUT_MS ?? '90000', 10);
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const REPO           = process.env.GITHUB_REPOSITORY;   // "owner/repo"
const PR_NUMBER      = process.env.PR_NUMBER;

// ---------------------------------------------------------------------------
// Run Jest
// ---------------------------------------------------------------------------
function runJest() {
  console.log(`[breakpoint-ci] Running Jest in ${DEMO_APP_DIR} …`);

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    ['test', '--', '--forceExit', '--detectOpenHandles', '--no-coverage', '--ci'],
    {
      cwd:      DEMO_APP_DIR,
      encoding: 'utf8',
      timeout:  TIMEOUT_MS,
      env:      { ...process.env, FORCE_COLOR: '0', CI: 'true' },
      shell:    false,
    }
  );

  const raw    = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
  const clean  = raw.replace(/\x1B\[[0-9;]*m/g, '');   // strip ANSI
  const exitCode = result.status ?? 1;

  console.log(clean);
  return { clean, exitCode };
}

// ---------------------------------------------------------------------------
// Parse Jest output
// ---------------------------------------------------------------------------
function parseSummary(output) {
  const summary = { passed: 0, failed: 0, total: 0, suites: 0 };

  const testsLine  = output.match(/Tests:\s*(.*)/);
  const suitesLine = output.match(/Test Suites:\s*(.*)/);

  if (testsLine) {
    const p = testsLine[1].match(/(\d+)\s+passed/);
    const f = testsLine[1].match(/(\d+)\s+failed/);
    const t = testsLine[1].match(/(\d+)\s+total/);
    if (p) summary.passed = parseInt(p[1], 10);
    if (f) summary.failed = parseInt(f[1], 10);
    if (t) summary.total  = parseInt(t[1], 10);
  }
  if (suitesLine) {
    const t = suitesLine[1].match(/(\d+)\s+total/);
    if (t) summary.suites = parseInt(t[1], 10);
  }

  return summary;
}

/** Extract individual failed test names from Jest output. */
function parseFailedTests(output) {
  const failed = [];
  // Jest marks failures with "● <suite name> › <test name>"
  const re = /^[\s]*●\s+(.+)$/gm;
  let m;
  while ((m = re.exec(output)) !== null) {
    const name = m[1].trim();
    // Skip sub-bullets that are error detail lines (contain "expect(")
    if (!name.includes('expect(') && !name.startsWith('at ')) {
      failed.push(name);
    }
  }
  return [...new Set(failed)];
}

// ---------------------------------------------------------------------------
// Build Merge Confidence Scorecard (Markdown)
// ---------------------------------------------------------------------------
function buildScorecard(summary, failedTests, exitCode, durationMs) {
  const verdict      = exitCode === 0;
  const passRate     = summary.total > 0
    ? ((summary.passed / summary.total) * 100).toFixed(1)
    : '0.0';
  const confidence   = verdict ? computeConfidence(summary) : 0;

  const statusBadge  = verdict
    ? '🟢 **PASSED** — safe to merge'
    : '🔴 **FAILED** — merge blocked';

  const confBar      = buildBar(confidence);

  const failBlock    = failedTests.length > 0
    ? `\n### ❌ Failing Tests\n${failedTests.map(t => `- \`${t}\``).join('\n')}\n`
    : '';

  const vulnWarning  = !verdict
    ? `\n> ⚠️ **Vulnerability Detected** — BreakPoint AI identified ${summary.failed} failing security ` +
      `test${summary.failed !== 1 ? 's' : ''}. Review the failures above before merging.\n`
    : '';

  return [
    `## 🛡️ BreakPoint AI — Merge Confidence Scorecard`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| **Status** | ${statusBadge} |`,
    `| **Merge Confidence** | ${confBar} ${confidence}% |`,
    `| **Tests Passed** | ${summary.passed} / ${summary.total} (${passRate}%) |`,
    `| **Tests Failed** | ${summary.failed} |`,
    `| **Test Suites** | ${summary.suites} |`,
    `| **Duration** | ${(durationMs / 1000).toFixed(1)} s |`,
    ``,
    vulnWarning,
    failBlock,
    `<details>`,
    `<summary>What is this?</summary>`,
    ``,
    `BreakPoint AI runs an automated fuzzing and concurrency-attack suite against every`,
    `pull request. It checks for input-validation bypasses, SQL/NoSQL injection, negative`,
    `amounts, race conditions, and double-spend vulnerabilities. A non-zero exit code`,
    `blocks the merge until all security tests pass.`,
    ``,
    `</details>`,
    ``,
    `---`,
    `*Generated by [BreakPoint AI](https://github.com/apps/breakpoint-ai) · ${new Date().toUTCString()}*`,
  ].join('\n');
}

function computeConfidence(summary) {
  if (summary.total === 0) return 0;
  return Math.round((summary.passed / summary.total) * 100);
}

function buildBar(pct) {
  const filled = Math.round(pct / 10);
  const empty  = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// ---------------------------------------------------------------------------
// Post GitHub PR comment
// ---------------------------------------------------------------------------
async function postComment(body) {
  if (!GITHUB_TOKEN || !REPO || !PR_NUMBER) {
    console.warn('[breakpoint-ci] GitHub env vars not set — skipping comment.');
    return;
  }

  const [owner, repoName] = REPO.split('/');
  const payload = JSON.stringify({ body });
  const url     = `https://api.github.com/repos/${owner}/${repoName}/issues/${PR_NUMBER}/comments`;

  console.log(`[breakpoint-ci] Posting scorecard to ${url} …`);

  return new Promise((resolve, reject) => {
    const options = {
      method:   'POST',
      hostname: 'api.github.com',
      path:     `/repos/${owner}/${repoName}/issues/${PR_NUMBER}/comments`,
      headers:  {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(payload),
        'Authorization':   `Bearer ${GITHUB_TOKEN}`,
        'Accept':          'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent':      'BreakPoint-AI-CI/1.0',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[breakpoint-ci] Comment posted (HTTP ${res.statusCode}).`);
          resolve();
        } else {
          console.error(`[breakpoint-ci] GitHub API error ${res.statusCode}: ${data}`);
          reject(new Error(`GitHub API responded with ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();

  const { clean, exitCode } = runJest();
  const duration   = Date.now() - t0;
  const summary    = parseSummary(clean);
  const failedTests = parseFailedTests(clean);

  const scorecard  = buildScorecard(summary, failedTests, exitCode, duration);

  console.log('\n' + '─'.repeat(60));
  console.log(scorecard);
  console.log('─'.repeat(60) + '\n');

  // Write the scorecard to a file so the workflow can upload it as an artifact
  const fs = require('fs');
  const outPath = path.join(__dirname, '..', 'breakpoint-scorecard.md');
  fs.writeFileSync(outPath, scorecard, 'utf8');
  console.log(`[breakpoint-ci] Scorecard written to ${outPath}`);

  try {
    await postComment(scorecard);
  } catch (err) {
    // A comment failure is non-fatal — the exit code still gates the merge
    console.error('[breakpoint-ci] Failed to post comment:', err.message);
  }

  if (exitCode !== 0) {
    console.error(
      `[breakpoint-ci] ❌ ${summary.failed} test(s) failed. Exiting with code 1 to block merge.`
    );
    process.exit(1);
  }

  console.log('[breakpoint-ci] ✅ All tests passed. Merge confidence: 100%');
  process.exit(0);
}

main().catch(err => {
  console.error('[breakpoint-ci] Unhandled error:', err);
  process.exit(1);
});
