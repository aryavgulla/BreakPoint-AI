#!/usr/bin/env node
/**
 * BreakPoint AI — MCP Server
 *
 * Exposes six tools (all LLM-agnostic):
 *
 *   get_git_diff     — Returns uncommitted git diff for a target directory.
 *   run_fuzzer       — Executes the test suite and returns a structured summary.
 *   read_test_logs   — Parses test files with optional suite / severity filtering.
 *   scan_ast         — Parses local JS/TS source files for security vulnerabilities.
 *   execute_fuzzer   — Dynamically runs Jest or pytest on any target path.
 *   apply_patch      — Rewrites source files with security fixes.
 *
 * TARGET DIRECTORY:
 *   The server resolves which project to operate on from (priority order):
 *     1. BREAKPOINT_TARGET env var  (set this to point at any project on disk)
 *     2. Legacy DEMO_APP_PATH env var
 *     3. Default: the demo-app/ directory shipped with this package
 *
 * Transport: stdio (spawned as a child process by any MCP client).
 *
 * Logging: ALL diagnostic output uses console.error — never console.log,
 *          which would corrupt the MCP protocol stream on stdout.
 */

import { McpServer }           from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z }                   from "zod";
import { execFile, spawn }     from "node:child_process";
import { promisify }           from "node:util";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
}                               from "node:fs";
import path                    from "node:path";
import { fileURLToPath }       from "node:url";

// ── Path helpers ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/**
 * Target directory resolution — in priority order:
 *   1. BREAKPOINT_TARGET env var  (explicit, for global install use)
 *   2. DEMO_APP_PATH env var       (legacy, kept for backwards compat)
 *   3. Default: demo-app/ next to this package (for development / demo use)
 *
 * This means the MCP server, when installed globally, can be pointed at ANY
 * project on the machine by setting BREAKPOINT_TARGET before launching it.
 */
const DEMO_APP_DIR: string = process.env.BREAKPOINT_TARGET
  ? path.resolve(process.env.BREAKPOINT_TARGET)
  : process.env.DEMO_APP_PATH
    ? path.resolve(process.env.DEMO_APP_PATH)
    : path.resolve(__dirname, "..", "..", "demo-app");

/**
 * Workspace root for git operations.
 * If a custom target is set, use its own directory as the root.
 */
const WORKSPACE_ROOT: string = process.env.BREAKPOINT_TARGET
  ? path.resolve(process.env.BREAKPOINT_TARGET)
  : path.resolve(__dirname, "..", "..", "..");

const execFileAsync = promisify(execFile);

// npm binary name differs on Windows
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

// ── Server ────────────────────────────────────────────────────────────────────
const server = new McpServer({
  name:    "breakpoint-mcp",
  version: "1.0.0",
});

// ── Tool: get_git_diff ────────────────────────────────────────────────────────
server.registerTool(
  "get_git_diff",
  {
    description: [
      "Returns the current uncommitted git diff (both staged and unstaged) for the",
      "BreakPoint AI demo-app directory. Use this to understand what code has changed",
      "before deciding whether to run tests or propose a patch.",
      "",
      "Set `file_path` to scope the diff to a single file (relative to demo-app/).",
      "Set `staged_only` to true to see only changes already added with `git add`.",
    ].join("\n"),
    inputSchema: z.object({
      file_path: z
        .string()
        .optional()
        .describe(
          "Optional relative file path inside demo-app/ to limit the diff, " +
          "e.g. 'routes/transfer.js'. Omit for the full tree."
        ),
      staged_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, only return staged (--cached) changes."),
    }),
  },
  async ({ file_path, staged_only }) => {
    try {
      const args = ["diff", "--stat", "-p"];
      if (staged_only) args.push("--cached");

      // Always scope to demo-app subtree
      args.push("--");
      if (file_path) {
        const abs = path.resolve(DEMO_APP_DIR, file_path);
        args.push(abs);
      } else {
        args.push(DEMO_APP_DIR);
      }

      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: WORKSPACE_ROOT,
        maxBuffer: 2 * 1024 * 1024, // 2 MB
      });

      if (stderr.trim()) {
        console.error("[get_git_diff] git stderr:", stderr.trim());
      }

      const diff = stdout.trim();
      if (!diff) {
        return {
          content: [{
            type: "text",
            text: "No uncommitted changes found in demo-app" +
                  (file_path ? ` for file '${file_path}'` : "") + ".",
          }],
        };
      }

      const lines   = diff.split("\n").length;
      const summary = `--- git diff (${lines} lines) ---\n\n${diff}`;
      return { content: [{ type: "text", text: summary }] };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // git not found, or not a git repo — surface as a recoverable error
      return {
        content: [{ type: "text", text: `get_git_diff failed: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: run_fuzzer ──────────────────────────────────────────────────────────
server.registerTool(
  "run_fuzzer",
  {
    description: [
      "Executes the Jest test suite inside demo-app/ and returns the full output",
      "plus a structured summary (passed, failed, total test count).",
      "",
      "Use `test_name_pattern` to run only tests whose names match a substring,",
      "e.g. 'Fuzzing' or 'Concurrency'. Omit to run all tests.",
      "",
      "The tool runs with --detectOpenHandles and --forceExit to prevent hangs.",
      "Execution may take up to 60 seconds for the full suite.",
    ].join("\n"),
    inputSchema: z.object({
      test_name_pattern: z
        .string()
        .optional()
        .describe(
          "Optional Jest -t pattern to filter which tests run, " +
          "e.g. 'Fuzzing', 'Concurrency', or 'negative amount'."
        ),
      timeout_ms: z
        .number()
        .int()
        .min(5_000)
        .max(120_000)
        .optional()
        .default(60_000)
        .describe("Max milliseconds to wait for the test run. Default 60 000."),
    }),
  },
  async ({ test_name_pattern, timeout_ms }) => {
    if (!existsSync(path.join(DEMO_APP_DIR, "package.json"))) {
      return {
        content: [{
          type: "text",
          text: `demo-app not found at ${DEMO_APP_DIR}. Cannot run tests.`,
        }],
        isError: true,
      };
    }

    return new Promise(resolve => {
      const args = ["test", "--", "--detectOpenHandles", "--forceExit", "--no-coverage"];
      if (test_name_pattern) args.push("-t", test_name_pattern);

      const child = spawn(NPM, args, {
        cwd: DEMO_APP_DIR,
        env: { ...process.env, FORCE_COLOR: "0", CI: "true" },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({
          content: [{
            type: "text",
            text: `run_fuzzer timed out after ${timeout_ms} ms.\n\nPartial output:\n${stdout}\n${stderr}`,
          }],
          isError: true,
        });
      }, timeout_ms);

      child.on("close", (code: number | null) => {
        clearTimeout(timer);

        const combined = stdout + "\n" + stderr;
        // Strip ANSI codes
        const clean = combined.replace(/\x1B\[[0-9;]*m/g, "");

        // Parse Jest summary line: "Tests: 3 failed, 9 passed, 12 total"
        const summary = parseJestSummary(clean);

        const report = [
          `=== Jest Run Report (exit code: ${code ?? "n/a"}) ===`,
          `Status  : ${code === 0 ? "ALL PASSED" : "FAILURES DETECTED"}`,
          `Passed  : ${summary.passed}`,
          `Failed  : ${summary.failed}`,
          `Total   : ${summary.total}`,
          `Suites  : ${summary.suites}`,
          "",
          "--- Full Output ---",
          clean.trim(),
        ].join("\n");

        resolve({
          content: [{ type: "text", text: report }],
          ...(code !== 0 ? { isError: false } : {}), // failures are normal — don't mark as tool error
        });
      });
    });
  }
);

// ── Tool: read_test_logs ──────────────────────────────────────────────────────
server.registerTool(
  "read_test_logs",
  {
    description: [
      "Parses the existing test files in demo-app/tests/ and returns their content,",
      "optionally filtered by suite name (e.g. 'fuzzing' or 'concurrency') and by",
      "severity ('fail' to see only failure-oriented test cases, 'all' for everything).",
      "",
      "Use this tool to understand what attack payloads are already covered before",
      "deciding whether new test cases are needed.",
    ].join("\n"),
    inputSchema: z.object({
      suite: z
        .enum(["fuzzing", "concurrency", "all"])
        .optional()
        .default("all")
        .describe(
          "Which test suite to read: 'fuzzing', 'concurrency', or 'all' (default)."
        ),
      severity: z
        .enum(["fail", "warn", "all"])
        .optional()
        .default("all")
        .describe(
          "Filter test cases by intent: 'fail' returns only tests expecting error " +
          "responses (4xx/5xx), 'warn' returns only advisory patterns, 'all' returns everything."
        ),
    }),
  },
  async ({ suite, severity }) => {
    const testsDir = path.join(DEMO_APP_DIR, "tests");

    if (!existsSync(testsDir)) {
      return {
        content: [{
          type: "text",
          text: `Tests directory not found at ${testsDir}. No test files have been generated yet.`,
        }],
        isError: true,
      };
    }

    let files: string[];
    try {
      files = readdirSync(testsDir)
        .filter(f => f.endsWith(".test.js") || f.endsWith(".test.ts"))
        .filter(f => {
          if (suite === "all") return true;
          return f.toLowerCase().includes(suite);
        })
        .sort();
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Failed to read tests directory: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }

    if (files.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No test files found matching suite='${suite}'.`,
        }],
      };
    }

    const sections: string[] = [];

    for (const file of files) {
      const fullPath = path.join(testsDir, file);
      let content: string;
      try {
        content = readFileSync(fullPath, "utf8");
      } catch {
        sections.push(`### ${file}\n[Could not read file]`);
        continue;
      }

      let lines = content.split("\n");

      // Severity filtering — heuristic: 'fail' keeps lines that reference 4xx/5xx, reject, error
      if (severity === "fail") {
        // Keep test blocks that assert on error status codes
        const FAIL_PATTERNS = [/40[0-9]|50[0-9]|reject|error|fail|invalid|missing|null|negativ/i];
        lines = filterTestBlocks(lines, FAIL_PATTERNS);
      } else if (severity === "warn") {
        const WARN_PATTERNS = [/warn|deprecat|race|concurrent|slow/i];
        lines = filterTestBlocks(lines, WARN_PATTERNS);
      }

      const stat = statSync(fullPath);
      const modified = stat.mtime.toISOString();
      const loc = content.split("\n").length;

      sections.push(
        `### ${file}  (${loc} lines, modified ${modified.slice(0, 19)})\n` +
        "```javascript\n" +
        lines.join("\n") +
        "\n```"
      );
    }

    const header =
      `# BreakPoint AI — Test Logs\n` +
      `Suite: ${suite}  |  Severity filter: ${severity}  |  Files: ${files.length}\n\n`;

    return {
      content: [{ type: "text", text: header + sections.join("\n\n---\n\n") }],
    };
  }
);

// ── Helpers ───────────────────────────────────────────────────────────────────

interface JestSummary {
  passed: number;
  failed: number;
  total:  number;
  suites: number;
}

/**
 * Parses lines like:
 *   Tests:       3 failed, 9 passed, 12 total
 *   Test Suites: 1 failed, 1 passed, 2 total
 */
function parseJestSummary(output: string): JestSummary {
  const result: JestSummary = { passed: 0, failed: 0, total: 0, suites: 0 };

  const testsLine  = output.match(/Tests:\s*(.*)/);
  const suitesLine = output.match(/Test Suites:\s*(.*)/);

  if (testsLine) {
    const passedM = testsLine[1].match(/(\d+)\s+passed/);
    const failedM = testsLine[1].match(/(\d+)\s+failed/);
    const totalM  = testsLine[1].match(/(\d+)\s+total/);
    if (passedM) result.passed = parseInt(passedM[1], 10);
    if (failedM) result.failed = parseInt(failedM[1], 10);
    if (totalM)  result.total  = parseInt(totalM[1], 10);
  }

  if (suitesLine) {
    const totalM = suitesLine[1].match(/(\d+)\s+total/);
    if (totalM) result.suites = parseInt(totalM[1], 10);
  }

  return result;
}

/**
 * Keeps only the test() blocks that contain at least one matching line.
 * Returns full file content if no pattern matches anything (graceful fallback).
 */
function filterTestBlocks(lines: string[], patterns: RegExp[]): string[] {
  const result: string[] = [];
  let inBlock = false;
  let blockLines: string[] = [];
  let depth = 0;
  let blockMatches = false;

  for (const line of lines) {
    const isTestStart = /^\s*(test|it)\s*\(/.test(line);

    if (isTestStart && depth === 0) {
      // Save previous block if matched
      if (blockLines.length > 0 && blockMatches) result.push(...blockLines);
      blockLines  = [line];
      blockMatches = patterns.some(p => p.test(line));
      inBlock = true;
      depth = (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      continue;
    }

    if (inBlock) {
      blockLines.push(line);
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (!blockMatches && patterns.some(p => p.test(line))) blockMatches = true;
      if (depth <= 0) {
        if (blockMatches) result.push(...blockLines);
        blockLines  = [];
        blockMatches = false;
        inBlock = false;
        depth   = 0;
      }
    } else {
      // Top-level lines (imports, describe, etc.) always included
      result.push(line);
    }
  }

  // Flush last block
  if (blockLines.length > 0 && blockMatches) result.push(...blockLines);

  return result.length > 0 ? result : lines; // fallback: return everything
}

// ── Tool: scan_ast ────────────────────────────────────────────────────────────
server.registerTool(
  "scan_ast",
  {
    description: [
      "Parses one or more local JS/TS source files and reports potential security",
      "vulnerabilities using static pattern analysis. No LLM or network call is made.",
      "",
      "Supply `file_paths` as an array of paths relative to demo-app/, e.g.",
      "['routes/transfer.js', 'server.js']. Omit to scan all .js/.ts files in demo-app/.",
      "",
      "Returns a JSON report with findings per file: rule ID, severity, line number,",
      "matched source snippet, and a remediation hint.",
    ].join("\n"),
    inputSchema: z.object({
      file_paths: z
        .array(z.string())
        .optional()
        .describe(
          "Array of file paths relative to demo-app/ to scan. " +
          "Omit to scan every .js/.ts file in demo-app/ (excluding node_modules)."
        ),
      severity_threshold: z
        .enum(["critical", "high", "medium", "low", "info"])
        .optional()
        .default("info")
        .describe(
          "Minimum severity to include in results. " +
          "'critical' returns only critical findings; 'info' returns everything."
        ),
    }),
  },
  async ({ file_paths, severity_threshold }) => {
    // Collect files to scan
    let targets: string[];
    if (file_paths && file_paths.length > 0) {
      targets = file_paths.map(f => path.resolve(DEMO_APP_DIR, f));
    } else {
      targets = collectSourceFiles(DEMO_APP_DIR, [".js", ".ts"]);
    }

    const severityRank: Record<string, number> = {
      critical: 5, high: 4, medium: 3, low: 2, info: 1,
    };
    const threshold = severityRank[severity_threshold ?? "info"] ?? 1;

    const allFindings: AstFinding[] = [];

    for (const absPath of targets) {
      if (!existsSync(absPath)) {
        allFindings.push({
          file: absPath,
          rule: "file-not-found",
          severity: "info",
          line: 0,
          snippet: "",
          hint: `File not found: ${absPath}`,
        });
        continue;
      }

      let src: string;
      try {
        src = readFileSync(absPath, "utf8");
      } catch (err) {
        allFindings.push({
          file: absPath,
          rule: "read-error",
          severity: "info",
          line: 0,
          snippet: "",
          hint: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      const findings = runAstRules(absPath, src);
      allFindings.push(...findings.filter(f => severityRank[f.severity] >= threshold));
    }

    // Group by file for readability
    const byFile: Record<string, AstFinding[]> = {};
    for (const f of allFindings) {
      (byFile[f.file] ??= []).push(f);
    }

    const report = {
      scanned_files:  targets.length,
      total_findings: allFindings.length,
      severity_counts: {
        critical: allFindings.filter(f => f.severity === "critical").length,
        high:     allFindings.filter(f => f.severity === "high").length,
        medium:   allFindings.filter(f => f.severity === "medium").length,
        low:      allFindings.filter(f => f.severity === "low").length,
        info:     allFindings.filter(f => f.severity === "info").length,
      },
      findings_by_file: Object.fromEntries(
        Object.entries(byFile).map(([file, findings]) => [
          path.relative(DEMO_APP_DIR, file),
          findings.map(({ file: _f, ...rest }) => rest),
        ])
      ),
    };

    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }
);

// ── Tool: execute_fuzzer ──────────────────────────────────────────────────────
server.registerTool(
  "execute_fuzzer",
  {
    description: [
      "Dynamically runs Jest or pytest on a specified target path and returns the",
      "full stdout/stderr output. Completely LLM-independent — pure process execution.",
      "",
      "Set `runner` to 'jest' (default) or 'pytest'.",
      "Set `target_path` to a file, directory, or test pattern to run.",
      "Set `extra_args` to pass additional CLI flags to the test runner.",
      "",
      "Returns a structured report with exit code, runner output, and parsed counts.",
    ].join("\n"),
    inputSchema: z.object({
      runner: z
        .enum(["jest", "pytest"])
        .optional()
        .default("jest")
        .describe("Test runner to use: 'jest' (default, Node.js) or 'pytest' (Python)."),
      target_path: z
        .string()
        .optional()
        .describe(
          "File, directory, or test name pattern to run. " +
          "Relative to demo-app/ for jest; absolute or relative for pytest. " +
          "Omit to run all tests."
        ),
      extra_args: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Additional CLI arguments to pass directly to the runner."),
      timeout_ms: z
        .number()
        .int()
        .min(5_000)
        .max(120_000)
        .optional()
        .default(60_000)
        .describe("Max milliseconds to wait for the run. Default 60 000."),
      working_dir: z
        .string()
        .optional()
        .describe(
          "Absolute path to the working directory. " +
          "Defaults to demo-app/ for jest and the workspace root for pytest."
        ),
    }),
  },
  async ({ runner, target_path, extra_args, timeout_ms, working_dir }) => {
    const cwd = working_dir
      ? path.resolve(working_dir)
      : runner === "pytest"
        ? WORKSPACE_ROOT
        : DEMO_APP_DIR;

    if (!existsSync(cwd)) {
      return {
        content: [{ type: "text", text: `Working directory not found: ${cwd}` }],
        isError: true,
      };
    }

    let cmd: string;
    let args: string[];

    if (runner === "jest") {
      cmd = NPM;
      args = ["test", "--", "--detectOpenHandles", "--forceExit", "--no-coverage"];
      if (target_path) args.push(target_path);
      if (extra_args && extra_args.length > 0) args.push(...extra_args);
    } else {
      // pytest
      const PY = process.platform === "win32" ? "python" : "python3";
      cmd = PY;
      args = ["-m", "pytest", "-v"];
      if (target_path) args.push(target_path);
      if (extra_args && extra_args.length > 0) args.push(...extra_args);
    }

    return new Promise(resolve => {
      const child = spawn(cmd, args, {
        cwd,
        env:   { ...process.env, FORCE_COLOR: "0", CI: "true" },
        shell: process.platform === "win32",
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({
          content: [{
            type: "text",
            text: [
              `execute_fuzzer timed out after ${timeout_ms} ms.`,
              `Runner : ${runner}`,
              `Command: ${cmd} ${args.join(" ")}`,
              `CWD    : ${cwd}`,
              "",
              "--- Partial stdout ---",
              stdout.trim(),
              "",
              "--- Partial stderr ---",
              stderr.trim(),
            ].join("\n"),
          }],
          isError: true,
        });
      }, timeout_ms ?? 60_000);

      child.on("close", (code: number | null) => {
        clearTimeout(timer);

        const combined = stdout + "\n" + stderr;
        const clean    = combined.replace(/\x1B\[[0-9;]*m/g, "");

        const summary  = runner === "jest"
          ? parseJestSummary(clean)
          : parsePytestSummary(clean);

        const report = [
          `=== ${runner.toUpperCase()} Run Report (exit code: ${code ?? "n/a"}) ===`,
          `Command : ${cmd} ${args.join(" ")}`,
          `CWD     : ${cwd}`,
          `Status  : ${code === 0 ? "ALL PASSED" : "FAILURES DETECTED"}`,
          `Passed  : ${summary.passed}`,
          `Failed  : ${summary.failed}`,
          `Total   : ${summary.total}`,
          ...(runner === "jest" ? [`Suites  : ${(summary as JestSummary).suites}`] : []),
          "",
          "--- Full Output ---",
          clean.trim(),
        ].join("\n");

        resolve({ content: [{ type: "text", text: report }] });
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({
          content: [{
            type: "text",
            text: [
              `execute_fuzzer failed to spawn process.`,
              `Runner : ${runner}`,
              `Command: ${cmd} ${args.join(" ")}`,
              `Error  : ${err.message}`,
            ].join("\n"),
          }],
          isError: true,
        });
      });
    });
  }
);

// ── Tool: apply_patch ─────────────────────────────────────────────────────────
server.registerTool(
  "apply_patch",
  {
    description: [
      "Rewrites one or more source files with security fixes. Two modes:",
      "",
      "  'replace' (default) — Performs exact string substitutions. Provide `patches`",
      "     as an array of { file, search, replace } objects. Each `search` string is",
      "     replaced with `replace` in the file. All occurrences are replaced.",
      "",
      "  'overwrite' — Writes the complete new content of a file. Provide `patches`",
      "     as an array of { file, content } objects.",
      "",
      "All `file` values are paths relative to demo-app/.",
      "A backup of each modified file is written alongside it with a .bak extension.",
      "Returns a summary of every file touched, lines changed, and backup paths.",
    ].join("\n"),
    inputSchema: z.object({
      mode: z
        .enum(["replace", "overwrite"])
        .optional()
        .default("replace")
        .describe("Patch mode: 'replace' for substring substitution, 'overwrite' for full-file rewrite."),
      patches: z
        .array(
          z.union([
            z.object({
              file:    z.string().describe("File path relative to demo-app/."),
              search:  z.string().describe("Exact string to find and replace (used in 'replace' mode)."),
              replace: z.string().describe("Replacement string (used in 'replace' mode)."),
            }),
            z.object({
              file:    z.string().describe("File path relative to demo-app/."),
              content: z.string().describe("Complete new file content (used in 'overwrite' mode)."),
            }),
          ])
        )
        .min(1)
        .describe("Array of patch operations to apply."),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When true, validate and preview changes without writing to disk. " +
          "Returns a diff-style preview of what would change."
        ),
    }),
  },
  async ({ mode, patches, dry_run }) => {
    const results: PatchResult[] = [];

    for (const patch of patches) {
      const absPath = path.resolve(DEMO_APP_DIR, patch.file);

      // Ensure we stay inside DEMO_APP_DIR / the target directory (path traversal guard)
        if (!absPath.startsWith(path.resolve(DEMO_APP_DIR) + path.sep) && absPath !== path.resolve(DEMO_APP_DIR)) {
        results.push({
          file:    patch.file,
          status:  "error",
          message: "Rejected: path traversal outside demo-app/ is not allowed.",
        });
        continue;
      }

      let original: string;
      try {
        original = readFileSync(absPath, "utf8");
      } catch (err) {
        results.push({
          file:    patch.file,
          status:  "error",
          message: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      if (mode === "overwrite") {
        const p = patch as { file: string; content: string };
        if (!("content" in p) || typeof p.content !== "string") {
          results.push({
            file:    patch.file,
            status:  "error",
            message: "Overwrite mode requires a 'content' field.",
          });
          continue;
        }

        const newContent = p.content;
        const linesOld   = original.split("\n").length;
        const linesNew   = newContent.split("\n").length;

        if (dry_run) {
          results.push({
            file:    patch.file,
            status:  "dry_run",
            message: `Would overwrite ${linesOld}-line file with ${linesNew}-line content.`,
            preview: buildSimpleDiff(original, newContent, patch.file),
          });
        } else {
          const backupPath = absPath + ".bak";
          try {
            writeFileSync(backupPath, original, "utf8");
            writeFileSync(absPath, newContent, "utf8");
            results.push({
              file:        patch.file,
              status:      "ok",
              message:     `Overwrote file. Lines: ${linesOld} → ${linesNew}.`,
              backup_path: path.relative(DEMO_APP_DIR, backupPath),
            });
          } catch (err) {
            results.push({
              file:    patch.file,
              status:  "error",
              message: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      } else {
        // replace mode
        const p = patch as { file: string; search: string; replace: string };
        if (!("search" in p) || !("replace" in p)) {
          results.push({
            file:    patch.file,
            status:  "error",
            message: "Replace mode requires 'search' and 'replace' fields.",
          });
          continue;
        }

        if (!original.includes(p.search)) {
          results.push({
            file:    patch.file,
            status:  "not_found",
            message: `Search string not found in file. No changes made.`,
            snippet: p.search.slice(0, 120),
          });
          continue;
        }

        // Count occurrences
        const occurrences = original.split(p.search).length - 1;
        const newContent  = original.split(p.search).join(p.replace);
        const linesOld    = original.split("\n").length;
        const linesNew    = newContent.split("\n").length;

        if (dry_run) {
          results.push({
            file:        patch.file,
            status:      "dry_run",
            message:     `Would replace ${occurrences} occurrence(s). Lines: ${linesOld} → ${linesNew}.`,
            preview:     buildSimpleDiff(original, newContent, patch.file),
          });
        } else {
          const backupPath = absPath + ".bak";
          try {
            writeFileSync(backupPath, original, "utf8");
            writeFileSync(absPath, newContent, "utf8");
            results.push({
              file:        patch.file,
              status:      "ok",
              message:     `Replaced ${occurrences} occurrence(s). Lines: ${linesOld} → ${linesNew}.`,
              backup_path: path.relative(DEMO_APP_DIR, backupPath),
            });
          } catch (err) {
            results.push({
              file:    patch.file,
              status:  "error",
              message: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    }

    const summary = {
      mode,
      dry_run:  dry_run ?? false,
      applied:  results.filter(r => r.status === "ok").length,
      errors:   results.filter(r => r.status === "error").length,
      not_found: results.filter(r => r.status === "not_found").length,
      results,
    };

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

// ── Entry point ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[breakpoint-mcp] Server running on stdio");
  console.error(`[breakpoint-mcp] Target directory : ${DEMO_APP_DIR}`);
  console.error(`[breakpoint-mcp] Workspace root   : ${WORKSPACE_ROOT}`);
  console.error("[breakpoint-mcp] Tools: get_git_diff, run_fuzzer, read_test_logs, scan_ast, execute_fuzzer, apply_patch");
  console.error("[breakpoint-mcp] Tip: set BREAKPOINT_TARGET env var to point at any project on your machine.");
}

main().catch(err => {
  console.error("[breakpoint-mcp] Fatal error:", err);
  process.exit(1);
});

// ── AST / static analysis helpers ────────────────────────────────────────────

interface AstFinding {
  file:     string;
  rule:     string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  line:     number;
  snippet:  string;
  hint:     string;
}

interface AstRule {
  id:       string;
  severity: AstFinding["severity"];
  pattern:  RegExp;
  hint:     string;
}

/** Security rules for static pattern scanning */
const AST_RULES: AstRule[] = [
  {
    id:       "sql-injection",
    severity: "critical",
    pattern:  /(?:query|execute|db\.run|connection\.query)\s*\(\s*[`"'].*\$\{|['"`]\s*\+\s*(?:req\.|params|body|query)/i,
    hint:     "Possible SQL injection: concatenating user input into a query. Use parameterised statements.",
  },
  {
    id:       "prototype-pollution",
    severity: "critical",
    pattern:  /Object\.assign\s*\(\s*\w+\s*,\s*req\.body\s*\)|deepMerge\s*\(.*req\.body|\[['"]__proto__['"]\]|\[['"]constructor['"]\]/i,
    hint:     "Prototype pollution risk: merging user-controlled data into an object without sanitisation.",
  },
  {
    id:       "eval-usage",
    severity: "critical",
    pattern:  /\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"]/i,
    hint:     "Dynamic code execution via eval() or new Function() is a code injection risk.",
  },
  {
    id:       "path-traversal",
    severity: "high",
    pattern:  /(?:readFile|writeFile|createReadStream|require)\s*\(\s*(?:req\.|path\.join|`[^`]*\$\{)/i,
    hint:     "Path traversal risk: user input used in file-system operations. Validate and canonicalise paths.",
  },
  {
    id:       "missing-auth",
    severity: "high",
    pattern:  /router\.(get|post|put|delete|patch)\s*\(\s*['"`][^'"`,]+['"`]\s*,\s*(?:async\s*)?\(\s*req\s*,\s*res\s*\)\s*=>/i,
    hint:     "Route handler registered without an explicit auth middleware — verify authentication is applied.",
  },
  {
    id:       "hardcoded-secret",
    severity: "high",
    pattern:  /(?:password|secret|apiKey|api_key|token|private_key)\s*[:=]\s*['"`][^'"`]{8,}/i,
    hint:     "Hardcoded credential detected. Move secrets to environment variables.",
  },
  {
    id:       "open-redirect",
    severity: "high",
    pattern:  /res\.redirect\s*\(\s*req\.(?:body|query|params)/i,
    hint:     "Open redirect: redirecting to a user-supplied URL without allowlist validation.",
  },
  {
    id:       "nosql-injection",
    severity: "high",
    pattern:  /\.find(?:One)?\s*\(\s*\{[^}]*req\.(?:body|query|params)/i,
    hint:     "NoSQL injection risk: user input used directly as a query filter without sanitisation.",
  },
  {
    id:       "xss-res-send",
    severity: "medium",
    pattern:  /res\.(send|write)\s*\(\s*req\.(?:body|query|params|headers)/i,
    hint:     "Reflected XSS: echoing raw user input in HTTP response. Encode output or use a template engine.",
  },
  {
    id:       "missing-input-validation",
    severity: "medium",
    pattern:  /req\.body\.(?:\w+)\s*(?!.*(?:typeof|isNaN|parseInt|parseFloat|Number\(|String\(|trim\(\)))/,
    hint:     "req.body property used without visible type/range validation — add explicit checks.",
  },
  {
    id:       "integer-overflow-risk",
    severity: "medium",
    pattern:  /amount\s*[+\-*/]=?\s*\d{10,}|balance\s*[+\-*/]=?\s*\d{10,}/i,
    hint:     "Large numeric constant used with financial variable — consider overflow / precision limits.",
  },
  {
    id:       "missing-rate-limit",
    severity: "low",
    pattern:  /app\.(?:use|post|get)\s*\([^)]*\)(?![\s\S]*rateLimit|throttle|limiter)/i,
    hint:     "No rate-limiting middleware detected on this route. Consider adding express-rate-limit.",
  },
  {
    id:       "console-log-in-prod",
    severity: "info",
    pattern:  /console\.log\s*\(/,
    hint:     "console.log found — replace with a structured logger that respects log levels in production.",
  },
  {
    id:       "todo-fixme",
    severity: "info",
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     "Unresolved TODO/FIXME comment — review before shipping.",
  },
];

/**
 * Runs all AST_RULES against the source code line-by-line and returns findings.
 */
function runAstRules(filePath: string, src: string): AstFinding[] {
  const lines   = src.split("\n");
  const findings: AstFinding[] = [];

  for (const rule of AST_RULES) {
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        findings.push({
          file:     filePath,
          rule:     rule.id,
          severity: rule.severity,
          line:     i + 1,
          snippet:  lines[i].trim().slice(0, 200),
          hint:     rule.hint,
        });
      }
    }
  }

  return findings;
}

/**
 * Recursively collects source files under `dir` matching the given extensions,
 * skipping node_modules and build directories.
 */
function collectSourceFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  const SKIP_DIRS = new Set(["node_modules", "build", ".git", "dist", "coverage"]);

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(current, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else if (extensions.includes(path.extname(entry))) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

// ── pytest summary parser ─────────────────────────────────────────────────────

interface TestSummary {
  passed: number;
  failed: number;
  total:  number;
}

/**
 * Parses pytest output lines like:
 *   "3 failed, 9 passed in 0.42s"
 *   "12 passed in 1.00s"
 */
function parsePytestSummary(output: string): TestSummary {
  const result: TestSummary = { passed: 0, failed: 0, total: 0 };
  const line = output.match(/=+\s+(.+?)\s+in\s+[\d.]+s\s*=+/);
  if (line) {
    const passedM = line[1].match(/(\d+)\s+passed/);
    const failedM = line[1].match(/(\d+)\s+failed/);
    if (passedM) result.passed = parseInt(passedM[1], 10);
    if (failedM) result.failed = parseInt(failedM[1], 10);
    result.total = result.passed + result.failed;
  }
  return result;
}

// ── apply_patch helpers ───────────────────────────────────────────────────────

interface PatchResult {
  file:         string;
  status:       "ok" | "error" | "not_found" | "dry_run";
  message:      string;
  backup_path?: string;
  snippet?:     string;
  preview?:     string;
}

/**
 * Builds a minimal unified-diff-style preview showing changed lines only.
 * Not a full diff algorithm — highlights first 40 lines that differ.
 */
function buildSimpleDiff(original: string, updated: string, label: string): string {
  const oldLines = original.split("\n");
  const newLines = updated.split("\n");
  const maxLen   = Math.max(oldLines.length, newLines.length);
  const chunks: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let shown = 0;

  for (let i = 0; i < maxLen && shown < 40; i++) {
    const o = oldLines[i] ?? "";
    const n = newLines[i] ?? "";
    if (o !== n) {
      chunks.push(`@@ line ${i + 1} @@`);
      if (o) chunks.push(`- ${o}`);
      if (n) chunks.push(`+ ${n}`);
      shown++;
    }
  }

  if (shown === 0) chunks.push("(no differences detected)");
  return chunks.join("\n");
}
