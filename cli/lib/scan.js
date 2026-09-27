'use strict';
/**
 * lib/scan.js
 *
 * CLI command: breakpoint scan --target <dir>
 *
 * Pure static analysis. No LLM, no network call, no special project layout.
 * Works on any JS/TS project anywhere on disk.
 */

const fs   = require('fs');
const path = require('path');
const { runAstRules, collectSourceFiles } = require('./scan-lib');

module.exports = function scan(targetDir, options = {}) {
  const {
    severity    = 'info',
    files       = null,
    format      = 'text',
    excludeDirs = [],
  } = options;

  const RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  const threshold = RANK[severity] ?? 1;

  // Collect files
  let targets;
  if (files) {
    // Comma-separated relative paths
    targets = files.split(',').map(f => path.resolve(targetDir, f.trim()));
  } else {
    // Load config to get extensions and excludes if present
    const configPath = path.join(targetDir, 'breakpoint.config.json');
    let cfg = {};
    if (fs.existsSync(configPath)) {
      try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    }
    const exts    = cfg.extensions || ['.js', '.ts', '.mjs', '.cjs'];
    const excl    = [...(cfg.exclude || []), ...excludeDirs];
    targets = collectSourceFiles(targetDir, exts, excl);
  }

  // Filter out test files unless explicitly specified
  if (!files) {
    targets = targets.filter(f => {
      const base = path.basename(f);
      return !base.endsWith('.test.js') && !base.endsWith('.test.ts')
          && !base.endsWith('.spec.js') && !base.endsWith('.spec.ts');
    });
  }

  const allFindings = [];

  for (const absPath of targets) {
    if (!fs.existsSync(absPath)) {
      console.error(`[scan] File not found: ${absPath}`);
      continue;
    }
    let src;
    try { src = fs.readFileSync(absPath, 'utf8'); } catch (e) {
      console.error(`[scan] Cannot read ${absPath}: ${e.message}`);
      continue;
    }
    const findings = runAstRules(absPath, src)
      .filter(f => RANK[f.severity] >= threshold);
    allFindings.push(...findings);
  }

  // Build report
  const report = {
    target:       targetDir,
    scanned:      targets.length,
    total:        allFindings.length,
    by_severity:  {
      critical: allFindings.filter(f => f.severity === 'critical').length,
      high:     allFindings.filter(f => f.severity === 'high').length,
      medium:   allFindings.filter(f => f.severity === 'medium').length,
      low:      allFindings.filter(f => f.severity === 'low').length,
      info:     allFindings.filter(f => f.severity === 'info').length,
    },
    findings: allFindings.map(f => ({
      ...f,
      file: path.relative(targetDir, f.file),
    })),
  };

  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Text output
  const SEV_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

  console.log(`\nBreakPoint AI — Static Scan`);
  console.log(`Target:  ${targetDir}`);
  console.log(`Scanned: ${report.scanned} files`);
  console.log(`Found:   ${report.total} findings  ` +
    `(${report.by_severity.critical} critical, ${report.by_severity.high} high, ` +
    `${report.by_severity.medium} medium, ${report.by_severity.low} low)\n`);

  if (report.total === 0) {
    console.log('  No findings above severity threshold.\n');
    return;
  }

  // Group by file
  const byFile = {};
  for (const f of report.findings) {
    (byFile[f.file] ??= []).push(f);
  }

  for (const [file, findings] of Object.entries(byFile)) {
    console.log(`  ${file}`);
    for (const f of findings) {
      const icon = SEV_ICON[f.severity] ?? '•';
      console.log(`    ${icon} [${f.severity.toUpperCase()}] line ${f.line} — ${f.rule}`);
      console.log(`       ${f.snippet}`);
      console.log(`       → ${f.hint}`);
    }
    console.log('');
  }

  // Exit non-zero if critical or high findings exist
  if (report.by_severity.critical > 0 || report.by_severity.high > 0) {
    process.exit(1);
  }
};
