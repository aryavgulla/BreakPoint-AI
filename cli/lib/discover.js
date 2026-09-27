'use strict';
/**
 * lib/discover.js
 *
 * Probes a project directory and returns:
 *   - testRunner: 'jest' | 'pytest' | 'mocha' | 'vitest' | 'unknown'
 *   - sourceFiles: array of absolute paths to relevant source files
 *   - specFile: path to openapi.json / swagger.json if found, else null
 *   - configFile: path to breakpoint.config.json if found, else null
 *
 * No hardcoded assumptions about project layout.
 */

const fs   = require('fs');
const path = require('path');
const { collectSourceFiles } = require('./scan-lib');

/**
 * Detect test runner from package.json or config files.
 */
function detectTestRunner(dir) {
  // Check package.json
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = {
        ...((pkg.dependencies)       || {}),
        ...((pkg.devDependencies)    || {}),
        ...((pkg.peerDependencies)   || {}),
      };
      if (deps['jest'])    return 'jest';
      if (deps['vitest'])  return 'vitest';
      if (deps['mocha'])   return 'mocha';
      // Check test script
      const testScript = (pkg.scripts && pkg.scripts.test) || '';
      if (testScript.includes('jest'))    return 'jest';
      if (testScript.includes('vitest'))  return 'vitest';
      if (testScript.includes('mocha'))   return 'mocha';
      if (testScript.includes('pytest'))  return 'pytest';
      if (testScript) return 'npm'; // has a test script but unknown runner — use npm test
    } catch {}
  }

  // Check for pytest config
  if (fs.existsSync(path.join(dir, 'pytest.ini'))
   || fs.existsSync(path.join(dir, 'pyproject.toml'))
   || fs.existsSync(path.join(dir, 'setup.cfg'))) {
    return 'pytest';
  }

  // Check for vitest config
  if (fs.existsSync(path.join(dir, 'vitest.config.js'))
   || fs.existsSync(path.join(dir, 'vitest.config.ts'))) {
    return 'vitest';
  }

  return 'unknown';
}

/**
 * Find an OpenAPI/Swagger spec file.
 */
function findSpecFile(dir) {
  const candidates = [
    'openapi.json', 'openapi.yaml', 'openapi.yml',
    'swagger.json', 'swagger.yaml', 'swagger.yml',
    'api.json', 'api.yaml',
    path.join('docs', 'openapi.json'),
    path.join('docs', 'swagger.json'),
    path.join('api', 'openapi.json'),
  ];
  for (const c of candidates) {
    const full = path.join(dir, c);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Full project discovery.
 */
function discoverEntryFiles(dir) {
  // Load config overrides if present
  const configPath = path.join(dir, 'breakpoint.config.json');
  let config = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  }

  const testRunner = config.testRunner || detectTestRunner(dir);
  const specFile   = config.specFile   ? path.resolve(dir, config.specFile) : findSpecFile(dir);

  // Source files: honour config include/exclude, otherwise collect all matching extensions
  let sourceFiles;
  if (config.include && Array.isArray(config.include)) {
    sourceFiles = config.include.map(f => path.resolve(dir, f)).filter(fs.existsSync);
  } else {
    const exts       = config.extensions || ['.js', '.ts', '.mjs', '.cjs'];
    const excludeDirs = Array.isArray(config.exclude) ? config.exclude : [];
    sourceFiles = collectSourceFiles(dir, exts, excludeDirs);
  }

  return {
    testRunner,
    sourceFiles,
    specFile,
    configFile: fs.existsSync(configPath) ? configPath : null,
  };
}

module.exports = { discoverEntryFiles, detectTestRunner, findSpecFile };
