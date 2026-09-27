'use strict';
/**
 * lib/init.js
 *
 * CLI command: breakpoint init --target <dir>
 *
 * Writes a breakpoint.config.json to the target directory.
 * The config lets you tell breakpoint exactly what to scan, which runner to use,
 * etc., so you never have to pass flags again for that project.
 */

const fs   = require('fs');
const path = require('path');
const { discoverEntryFiles }    = require('./discover');
const { getSupportedExtensions } = require('./scan-lib');

module.exports = function init(targetDir) {
  const configPath = path.join(targetDir, 'breakpoint.config.json');

  if (fs.existsSync(configPath)) {
    console.log(`[breakpoint] Config already exists: ${configPath}`);
    console.log('[breakpoint] Delete it first if you want to regenerate.');
    process.exit(0);
  }

  // Auto-discover so the generated config is accurate
  const discovered = discoverEntryFiles(targetDir);

  const config = {
    "$schema":    "https://breakpoint-ai.dev/schema/config.json",

    // Which test runner to use. Auto-detected, but you can override.
    "testRunner": discovered.testRunner,

    // Path to your OpenAPI/Swagger spec (relative to this file). Null = not found.
    "specFile":   discovered.specFile
      ? path.relative(targetDir, discovered.specFile).replace(/\\/g, '/')
      : null,

    // File extensions to scan — auto-detected from project, limited to extensions
    // that the scanner has rules for. Edit freely.
    // Supported: .js .ts .mjs .cjs .py .java .go .php .rb .cs .rs
    "extensions": (() => {
      const supported = new Set(getSupportedExtensions());
      // Probe which extension types are actually present in the project
      const present   = discovered.sourceFiles
        .map(f => path.extname(f).toLowerCase())
        .filter(e => supported.has(e));
      const unique = [...new Set(present)];
      return unique.length > 0 ? unique.sort() : getSupportedExtensions();
    })(),

    // Explicit include list overrides extension-based discovery.
    // Set to an array of relative paths to audit only those files.
    // "include": ["src/routes/transfer.js", "src/middleware/auth.js"],

    // Directories to exclude from scanning (in addition to node_modules, dist, etc.)
    "exclude": [],

    // Maximum Red/Blue/Judge rounds. More rounds = more thorough but costs more tokens.
    "maxRounds": 5,

    // watsonx model to use. Override if you have a preferred model.
    "modelId": process.env.MODEL_ID || "ibm/granite-3-3-8b-instruct",

    // Where to write audit reports. Relative to this config file.
    "outputDir": ".breakpoint/audit-reports",

    // Minimum severity to report in static scan: critical|high|medium|low|info
    "minSeverity": "low",
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  console.log(`\n[breakpoint] Initialised → ${configPath}`);
  console.log(`\n  Detected test runner: ${discovered.testRunner}`);
  console.log(`  Source files found:   ${discovered.sourceFiles.length}`);
  if (discovered.specFile) {
    console.log(`  API spec found:       ${path.relative(targetDir, discovered.specFile)}`);
  }
  console.log(`\nNext steps:`);
  console.log(`  1. Review and edit breakpoint.config.json as needed.`);
  console.log(`  2. Export WATSONX_API_KEY and WATSONX_PROJECT_ID.`);
  console.log(`  3. Run: breakpoint audit --target ${targetDir}`);
  console.log(`     Or just: cd ${targetDir} && breakpoint audit\n`);

  // Add .breakpoint/ to .gitignore if one exists
  const gitignorePath = path.join(targetDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gi = fs.readFileSync(gitignorePath, 'utf8');
    if (!gi.includes('.breakpoint')) {
      fs.appendFileSync(gitignorePath, '\n# BreakPoint AI audit output\n.breakpoint/\n');
      console.log(`  Added .breakpoint/ to .gitignore`);
    }
  }
};
