#!/usr/bin/env node
/**
 * breakpoint — standalone security auditor CLI
 *
 * Does NOT require Bob, an MCP client, or any specific project layout.
 * Install once globally:
 *
 *   npm install -g breakpoint-ai
 *
 * Then run against any project on your machine:
 *
 *   breakpoint audit --target /path/to/your/app
 *   breakpoint scan  --target /path/to/your/app
 *   breakpoint dash  --target /path/to/your/app
 *   breakpoint init  --target /path/to/your/app
 *
 * Required env vars for 'audit':
 *   WATSONX_API_KEY      — IBM watsonx.ai API key
 *   WATSONX_PROJECT_ID   — IBM watsonx.ai project ID
 *
 * Optional:
 *   WATSONX_URL          — defaults to https://us-south.ml.cloud.ibm.com
 *   MODEL_ID             — defaults to ibm/granite-3-3-8b-instruct
 *   MAX_ROUNDS           — defaults to 5
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ── Parse CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getFlag(name, defaultVal) {
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return defaultVal;
}

function hasFlag(name) {
  return args.includes(name);
}

const command = args[0];

if (!command || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

const rawTarget = getFlag('--target', null);

// ── Resolve target directory ───────────────────────────────────────────────────
// Priority: --target flag > BREAKPOINT_TARGET env > current working directory
function resolveTarget(raw) {
  const raw2 = raw || process.env.BREAKPOINT_TARGET || process.cwd();
  const abs  = path.resolve(raw2);
  if (!fs.existsSync(abs)) {
    console.error(`[breakpoint] ERROR: target directory not found: ${abs}`);
    process.exit(1);
  }
  if (!fs.statSync(abs).isDirectory()) {
    console.error(`[breakpoint] ERROR: target must be a directory, not a file: ${abs}`);
    process.exit(1);
  }
  return abs;
}

// ── Route to sub-commands ──────────────────────────────────────────────────────
switch (command) {
  case 'audit':
    require('../lib/audit')(resolveTarget(rawTarget), {
      rounds:    parseInt(getFlag('--rounds', process.env.MAX_ROUNDS || '5'), 10),
      model:     getFlag('--model',  process.env.MODEL_ID  || 'ibm/granite-3-3-8b-instruct'),
      outputDir: getFlag('--out',    null),
      verbose:   hasFlag('--verbose') || hasFlag('-v'),
    });
    break;

  case 'scan':
    require('../lib/scan')(resolveTarget(rawTarget), {
      severity:  getFlag('--severity', 'info'),
      files:     getFlag('--files', null),
      format:    getFlag('--format', 'text'),
    });
    break;

  case 'dash':
    require('../lib/dash')(resolveTarget(rawTarget), {
      port: parseInt(getFlag('--port', process.env.PORT || '4242'), 10),
    });
    break;

  case 'init':
    require('../lib/init')(resolveTarget(rawTarget));
    break;

  case 'run-tests':
    require('../lib/run-tests')(resolveTarget(rawTarget), {
      pattern: getFlag('--pattern', null),
      runner:  getFlag('--runner', 'auto'),
      timeout: parseInt(getFlag('--timeout', '120000'), 10),
    });
    break;

  default:
    console.error(`[breakpoint] Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

// ── Help text ──────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
  BreakPoint AI — autonomous security auditor

  USAGE
    breakpoint <command> [--target <dir>] [options]

  If --target is omitted, the current working directory is used.
  Set BREAKPOINT_TARGET env var to make a permanent default.

  COMMANDS
    audit        Run the full Red Team → Blue Team → Judge loop against a project.
                 Requires WATSONX_API_KEY and WATSONX_PROJECT_ID env vars.

    scan         Run static analysis on source files. No AI, no network call.

    dash         Start the web dashboard on localhost (default port 4242).

    init         Scaffold a breakpoint.config.json in a project directory.

    run-tests    Execute the test suite in a project and print results.

  OPTIONS
    --target <dir>       Path to the project to audit (default: cwd)
    --rounds  <n>        Max Red/Blue/Judge rounds for 'audit' (default: 5)
    --model   <id>       watsonx model ID (default: ibm/granite-3-3-8b-instruct)
    --out     <dir>      Directory to write audit reports to
    --severity <level>   Min severity for 'scan': critical|high|medium|low|info
    --files   <glob>     File glob for 'scan' (relative to --target)
    --format  <fmt>      Output format for 'scan': text|json
    --port    <n>        Port for 'dash' (default: 4242)
    --runner  <r>        Test runner for 'run-tests': auto|jest|pytest
    --pattern <p>        Test name filter pattern for 'run-tests'
    --timeout <ms>       Test timeout in ms (default: 120000)
    --verbose, -v        Print extra diagnostic output
    --help,    -h        Show this help

  EXAMPLES
    # Audit any app on your drive
    breakpoint audit --target C:/Users/you/my-express-app

    # Scan without AI (pure static analysis)
    breakpoint scan --target ~/projects/api --severity high --format json

    # Open the dashboard pointed at an app
    breakpoint dash --target ~/projects/api --port 3000

    # Init a config file in a project
    breakpoint init --target ~/projects/api

  ENV VARS
    WATSONX_API_KEY       IBM watsonx.ai API key (required for 'audit')
    WATSONX_PROJECT_ID    IBM watsonx.ai project ID (required for 'audit')
    WATSONX_URL           watsonx endpoint (default: https://us-south.ml.cloud.ibm.com)
    MODEL_ID              LLM model ID
    MAX_ROUNDS            Max audit rounds
    BREAKPOINT_TARGET     Default target directory (overridden by --target)
  `);
}
