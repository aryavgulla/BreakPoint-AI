'use strict';
/**
 * lib/run-tests-lib.js
 *
 * Shared test runner logic.
 * Works with jest, vitest, mocha, pytest, or raw 'npm test' —
 * auto-detected from the project, or passed in explicitly.
 */

const { spawnSync } = require('child_process');
const path          = require('path');
const { detectTestRunner } = require('./discover');

const IS_WIN = process.platform === 'win32';
const NPM    = IS_WIN ? 'npm.cmd' : 'npm';
const PY     = IS_WIN ? 'python'  : 'python3';

/**
 * Run the test suite in `targetDir`.
 *
 * @param {string}      targetDir  Absolute path to project root
 * @param {string|null} runner     'jest'|'vitest'|'mocha'|'pytest'|'npm'|'auto'|null
 * @param {string|null} pattern    Test name filter (passed as -t for jest)
 * @param {number}      timeout    Timeout in ms
 * @returns {{ output: string, exitCode: number }}
 */
function runTests(targetDir, runner, pattern, timeout) {
  const resolvedRunner = (!runner || runner === 'auto' || runner === 'unknown')
    ? detectTestRunner(targetDir)
    : runner;

  let cmd, args;

  switch (resolvedRunner) {
    case 'jest':
      cmd  = NPM;
      args = ['test', '--', '--detectOpenHandles', '--forceExit', '--no-coverage'];
      if (pattern) args.push('-t', pattern);
      break;

    case 'vitest':
      cmd  = NPM;
      args = ['test', '--', '--reporter=verbose'];
      if (pattern) args.push('-t', pattern);
      break;

    case 'mocha':
      cmd  = NPM;
      args = ['test'];
      if (pattern) args.push('--grep', pattern);
      break;

    case 'pytest':
      cmd  = PY;
      args = ['-m', 'pytest', '-v'];
      if (pattern) args.push('-k', pattern);
      break;

    case 'npm':
    default:
      // Fallback: whatever npm test does
      cmd  = NPM;
      args = ['test'];
      break;
  }

  const result = spawnSync(cmd, args, {
    cwd:      targetDir,
    encoding: 'utf8',
    timeout:  timeout || 120_000,
    shell:    IS_WIN,
    env:      { ...process.env, FORCE_COLOR: '0', CI: 'true' },
  });

  const output   = (result.stdout || '') + (result.stderr || '');
  const exitCode = result.status ?? 1;

  return { output, exitCode, runner: resolvedRunner };
}

module.exports = { runTests, detectTestRunner };
