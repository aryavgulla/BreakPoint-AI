'use strict';
/**
 * lib/run-tests.js
 *
 * CLI command: breakpoint run-tests --target <dir>
 */

const { runTests } = require('./run-tests-lib');

module.exports = function runTestsCmd(targetDir, options = {}) {
  const {
    pattern = null,
    runner  = 'auto',
    timeout = 120_000,
  } = options;

  console.log(`\n[breakpoint] Running tests in: ${targetDir}`);
  if (runner !== 'auto') console.log(`[breakpoint] Runner: ${runner}`);
  if (pattern) console.log(`[breakpoint] Pattern: ${pattern}`);

  const { output, exitCode, runner: resolvedRunner } = runTests(targetDir, runner, pattern, timeout);

  console.log(`\n[breakpoint] Runner used: ${resolvedRunner}`);
  console.log(`[breakpoint] Exit code:   ${exitCode}`);
  console.log('\n--- Test Output ---\n');
  console.log(output);

  process.exit(exitCode);
};
