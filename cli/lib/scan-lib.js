'use strict';
/**
 * lib/scan-lib.js
 *
 * Pure static analysis — no LLM, no network.
 * Usable by both the 'scan' CLI command and the audit engine.
 */

const fs   = require('fs');
const path = require('path');

// ── Security rules ─────────────────────────────────────────────────────────────
// Rules are language-agnostic unless prefixed with [py] (Python-only patterns).
const AST_RULES = [
  // ── JavaScript / TypeScript ──────────────────────────────────────────────────
  {
    id:       'sql-injection',
    severity: 'critical',
    pattern:  /(?:query|execute|db\.run|connection\.query)\s*\(\s*[`"'].*\$\{|['"`]\s*\+\s*(?:req\.|params|body|query)/i,
    hint:     'Possible SQL injection: concatenating user input into a query. Use parameterised statements.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'prototype-pollution',
    severity: 'critical',
    pattern:  /Object\.assign\s*\(\s*\w+\s*,\s*req\.body\s*\)|deepMerge\s*\(.*req\.body|\[['"]__proto__['"]\]|\[['"]constructor['"]\]/i,
    hint:     'Prototype pollution risk: merging user-controlled data into an object without sanitisation.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'eval-usage',
    severity: 'critical',
    pattern:  /\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"]/i,
    hint:     'Dynamic code execution via eval() or new Function() is a code injection risk.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'path-traversal',
    severity: 'high',
    pattern:  /(?:readFile|writeFile|createReadStream|require)\s*\(\s*(?:req\.|path\.join|`[^`]*\$\{)/i,
    hint:     'Path traversal risk: user input used in file-system operations. Validate and canonicalise paths.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'missing-auth',
    severity: 'high',
    pattern:  /router\.(get|post|put|delete|patch)\s*\(\s*['"`][^'"`,]+['"`]\s*,\s*(?:async\s*)?\(\s*req\s*,\s*res\s*\)\s*=>/i,
    hint:     'Route handler registered without an explicit auth middleware — verify authentication is applied.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|apiKey|api_key|token|private_key)\s*[:=]\s*['"`][^'"`]{8,}/i,
    hint:     'Hardcoded credential detected. Move secrets to environment variables.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'open-redirect',
    severity: 'high',
    pattern:  /res\.redirect\s*\(\s*req\.(?:body|query|params)/i,
    hint:     'Open redirect: redirecting to a user-supplied URL without allowlist validation.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'nosql-injection',
    severity: 'high',
    pattern:  /\.find(?:One)?\s*\(\s*\{[^}]*req\.(?:body|query|params)/i,
    hint:     'NoSQL injection risk: user input used directly as a query filter without sanitisation.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'xss-res-send',
    severity: 'medium',
    pattern:  /res\.(send|write)\s*\(\s*req\.(?:body|query|params|headers)/i,
    hint:     'Reflected XSS: echoing raw user input in HTTP response.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'missing-input-validation',
    severity: 'medium',
    pattern:  /req\.body\.(?:\w+)\s*(?!.*(?:typeof|isNaN|parseInt|parseFloat|Number\(|String\(|trim\(\)))/,
    hint:     'req.body property used without visible type/range validation.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'integer-overflow-risk',
    severity: 'medium',
    pattern:  /amount\s*[+\-*/]=?\s*\d{10,}|balance\s*[+\-*/]=?\s*\d{10,}/i,
    hint:     'Large numeric constant used with financial variable — consider overflow/precision limits.',
  },
  {
    id:       'missing-rate-limit',
    severity: 'low',
    pattern:  /app\.(?:use|post|get)\s*\([^)]*\)(?![\s\S]*rateLimit|throttle|limiter)/i,
    hint:     'No rate-limiting middleware detected on this route.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'console-log-in-prod',
    severity: 'info',
    pattern:  /console\.log\s*\(/,
    hint:     'console.log found — replace with a structured logger in production.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },
  {
    id:       'todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment — review before shipping.',
    exts:     ['.js', '.ts', '.mjs', '.cjs'],
  },

  // ── Python rules ──────────────────────────────────────────────────────────────
  {
    id:       'py-sql-injection',
    severity: 'critical',
    pattern:  /(?:execute|cursor\.execute)\s*\(\s*(?:f['"]|['"].*%\s*(?:req|request|input|user)|['"].*\+)/i,
    hint:     'Python SQL injection: string-formatting user input into a query. Use parameterised queries with ? or %s.',
    exts:     ['.py'],
  },
  {
    id:       'py-command-injection',
    severity: 'critical',
    pattern:  /(?:os\.system|subprocess\.(?:call|run|Popen|check_output))\s*\(\s*(?:f['"]|['"].*\+|.*request\.|.*input\()/i,
    hint:     'Command injection: user-controlled data passed to a shell command. Use subprocess with a list, never shell=True with user input.',
    exts:     ['.py'],
  },
  {
    id:       'py-eval',
    severity: 'critical',
    pattern:  /\beval\s*\(|exec\s*\(/i,
    hint:     'Python eval()/exec() is a code injection risk. Never pass user input to these.',
    exts:     ['.py'],
  },
  {
    id:       'py-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|api_key|apikey|token|private_key|SECRET_KEY)\s*=\s*['"][^'"]{8,}/i,
    hint:     'Hardcoded credential in Python source. Move to environment variables (os.environ or dotenv).',
    exts:     ['.py'],
  },
  {
    id:       'py-path-traversal',
    severity: 'high',
    pattern:  /open\s*\(\s*(?:request\.|f['"]|os\.path\.join\s*\([^)]*request\.)/i,
    hint:     'Path traversal risk: user-controlled path passed to open(). Validate and resolve against a safe base dir.',
    exts:     ['.py'],
  },
  {
    id:       'py-pickle-deserialise',
    severity: 'high',
    pattern:  /pickle\.loads?\s*\(|yaml\.load\s*\([^,)]+\)/i,
    hint:     'Unsafe deserialisation: pickle.load and yaml.load(str) without Loader can execute arbitrary code. Use yaml.safe_load instead.',
    exts:     ['.py'],
  },
  {
    id:       'py-flask-debug',
    severity: 'high',
    pattern:  /app\.run\s*\([^)]*debug\s*=\s*True/i,
    hint:     'Flask debug=True enables the interactive debugger in production — remote code execution risk. Disable before deploying.',
    exts:     ['.py'],
  },
  {
    id:       'py-missing-auth',
    severity: 'high',
    pattern:  /@app\.route\s*\([^)]+\)\s*\ndef\s+\w+\s*\(\s*\)/i,
    hint:     'Flask route defined without apparent auth decorator (@login_required / @jwt_required). Verify authentication is enforced.',
    exts:     ['.py'],
  },
  {
    id:       'py-xss-render',
    severity: 'medium',
    pattern:  /render_template_string\s*\(|Markup\s*\(\s*request\./i,
    hint:     'XSS risk: render_template_string or Markup() with user input bypasses Jinja2 auto-escaping.',
    exts:     ['.py'],
  },
  {
    id:       'py-open-redirect',
    severity: 'medium',
    pattern:  /redirect\s*\(\s*request\.(?:args|form|json|values)/i,
    hint:     'Open redirect: redirecting to a user-supplied URL. Validate against an allowlist.',
    exts:     ['.py'],
  },
  {
    id:       'py-shell-true',
    severity: 'medium',
    pattern:  /subprocess\.(?:call|run|Popen)\s*\([^)]*shell\s*=\s*True/i,
    hint:     'shell=True in subprocess is dangerous when any part of the command comes from user input.',
    exts:     ['.py'],
  },
  {
    id:       'py-requests-verify-false',
    severity: 'medium',
    pattern:  /requests\.\w+\s*\([^)]*verify\s*=\s*False/i,
    hint:     'SSL verification disabled (verify=False) — vulnerable to MITM attacks in production.',
    exts:     ['.py'],
  },
  {
    id:       'py-print-in-prod',
    severity: 'info',
    pattern:  /\bprint\s*\(/,
    hint:     'print() found — use Python logging module in production for structured, level-aware output.',
    exts:     ['.py'],
  },
  {
    id:       'py-todo-fixme',
    severity: 'info',
    pattern:  /#\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment — review before shipping.',
    exts:     ['.py'],
  },

  // ── Java rules ────────────────────────────────────────────────────────────────
  {
    id:       'java-sql-injection',
    severity: 'critical',
    pattern:  /(?:createStatement|prepareStatement|executeQuery|executeUpdate)\s*\(\s*(?:[^)]*\+\s*(?:request|req|param|input)|"[^"]*"\s*\+)/i,
    hint:     'Java SQL injection: string-concatenated query. Use PreparedStatement with ? parameters.',
    exts:     ['.java'],
  },
  {
    id:       'java-xxe',
    severity: 'critical',
    pattern:  /DocumentBuilderFactory\.newInstance\(\)|SAXParserFactory\.newInstance\(\)|XMLInputFactory\.newInstance\(\)/i,
    hint:     'XXE risk: XML parser instantiated without disabling external entity processing. Explicitly disable DOCTYPE declarations.',
    exts:     ['.java'],
  },
  {
    id:       'java-deserialisation',
    severity: 'critical',
    pattern:  /new\s+ObjectInputStream\s*\(|\.readObject\s*\(\s*\)/i,
    hint:     'Unsafe Java deserialisation via ObjectInputStream. Use a safe alternative or validate the stream before deserialising.',
    exts:     ['.java'],
  },
  {
    id:       'java-command-injection',
    severity: 'critical',
    pattern:  /Runtime\.getRuntime\(\)\.exec\s*\(|ProcessBuilder\s*\(\s*(?:Arrays\.asList|List\.of)?\s*(?:request|req|param)/i,
    hint:     'Command injection: user-controlled data in Runtime.exec or ProcessBuilder. Use a command list, never string concatenation.',
    exts:     ['.java'],
  },
  {
    id:       'java-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|apiKey|api_key|token|privateKey)\s*=\s*"[^"]{8,}"/i,
    hint:     'Hardcoded credential in Java source. Externalise to environment variables or a secrets manager.',
    exts:     ['.java'],
  },
  {
    id:       'java-path-traversal',
    severity: 'high',
    pattern:  /new\s+File\s*\(\s*(?:request\.getParameter|req\.getParam)/i,
    hint:     'Path traversal: user-supplied path passed to File constructor. Canonicalise and validate against a safe base directory.',
    exts:     ['.java'],
  },
  {
    id:       'java-todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.java'],
  },

  // ── Go rules ──────────────────────────────────────────────────────────────────
  {
    id:       'go-sql-injection',
    severity: 'critical',
    pattern:  /db\.(?:Query|Exec|QueryRow)\s*\(\s*(?:fmt\.Sprintf|"[^"]*"\s*\+)/i,
    hint:     'Go SQL injection: query built with fmt.Sprintf or string concatenation. Use parameterised queries with ?/$1.',
    exts:     ['.go'],
  },
  {
    id:       'go-command-injection',
    severity: 'critical',
    pattern:  /exec\.Command\s*\(\s*(?:fmt\.Sprintf|"[^"]*"\s*\+|r\.(?:URL|FormValue|PostForm))/i,
    hint:     'Command injection in exec.Command with user-controlled input. Pass arguments as separate strings, not shell-interpolated.',
    exts:     ['.go'],
  },
  {
    id:       'go-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|apiKey|api_key|token|privateKey)\s*(?::=|=)\s*"[^"]{8,}"/i,
    hint:     'Hardcoded credential in Go source. Use os.Getenv or a secrets manager.',
    exts:     ['.go'],
  },
  {
    id:       'go-path-traversal',
    severity: 'high',
    pattern:  /os\.Open\s*\(\s*(?:r\.URL\.Query|r\.FormValue|filepath\.Join\s*\([^)]*r\.)/i,
    hint:     'Path traversal: user input used in os.Open. Use filepath.Clean and validate against a safe base.',
    exts:     ['.go'],
  },
  {
    id:       'go-todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.go'],
  },

  // ── PHP rules ─────────────────────────────────────────────────────────────────
  {
    id:       'php-sql-injection',
    severity: 'critical',
    pattern:  /(?:mysql_query|mysqli_query|->query)\s*\(\s*(?:"[^"]*"\s*\.|'[^']*'\s*\.|\$_(?:GET|POST|REQUEST|COOKIE))/i,
    hint:     'PHP SQL injection: user superglobal concatenated into query. Use PDO with prepared statements.',
    exts:     ['.php'],
  },
  {
    id:       'php-command-injection',
    severity: 'critical',
    pattern:  /(?:exec|shell_exec|system|passthru|popen)\s*\(\s*\$_(?:GET|POST|REQUEST)/i,
    hint:     'Command injection: PHP superglobal passed to a shell function. Use escapeshellarg() or avoid shell calls entirely.',
    exts:     ['.php'],
  },
  {
    id:       'php-eval',
    severity: 'critical',
    pattern:  /\beval\s*\(|preg_replace\s*\([^,]*\/e/i,
    hint:     'PHP eval() or preg_replace with /e modifier executes arbitrary code.',
    exts:     ['.php'],
  },
  {
    id:       'php-file-inclusion',
    severity: 'critical',
    pattern:  /(?:include|require|include_once|require_once)\s*\(\s*\$_(?:GET|POST|REQUEST)/i,
    hint:     'Remote/local file inclusion: user-controlled path in include/require. Use a strict allowlist.',
    exts:     ['.php'],
  },
  {
    id:       'php-xss',
    severity: 'high',
    pattern:  /echo\s+\$_(?:GET|POST|REQUEST|COOKIE)|print\s+\$_(?:GET|POST|REQUEST)/i,
    hint:     'Reflected XSS: echoing raw user input. Use htmlspecialchars() with ENT_QUOTES.',
    exts:     ['.php'],
  },
  {
    id:       'php-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:\$password|\$secret|\$api_key|\$token)\s*=\s*['"][^'"]{8,}/i,
    hint:     'Hardcoded credential in PHP. Use environment variables via getenv() or $_ENV.',
    exts:     ['.php'],
  },
  {
    id:       'php-todo-fixme',
    severity: 'info',
    pattern:  /(?:\/\/|#)\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.php'],
  },

  // ── Ruby rules ────────────────────────────────────────────────────────────────
  {
    id:       'ruby-sql-injection',
    severity: 'critical',
    pattern:  /(?:where|find_by_sql|execute)\s*\(\s*["'].*#\{|["']\s*\+\s*(?:params|request)/i,
    hint:     'Ruby SQL injection: string interpolation in ActiveRecord query. Use parameterised conditions (where("col = ?", val)).',
    exts:     ['.rb'],
  },
  {
    id:       'ruby-command-injection',
    severity: 'critical',
    pattern:  /`[^`]*#\{|(?:system|exec|spawn|IO\.popen)\s*\(\s*["'].*#\{/i,
    hint:     'Command injection: user input interpolated into a shell command or backtick. Use array form of system().',
    exts:     ['.rb'],
  },
  {
    id:       'ruby-eval',
    severity: 'critical',
    pattern:  /\beval\s*\(|instance_eval\s*\(|class_eval\s*\(/i,
    hint:     'Ruby eval/instance_eval with dynamic input is a code injection risk.',
    exts:     ['.rb'],
  },
  {
    id:       'ruby-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|api_key|token|private_key)\s*=\s*['"][^'"]{8,}/i,
    hint:     'Hardcoded credential in Ruby. Use Rails credentials, dotenv, or environment variables.',
    exts:     ['.rb'],
  },
  {
    id:       'ruby-mass-assignment',
    severity: 'high',
    pattern:  /\.update_attributes\s*\(\s*params\[|\.new\s*\(\s*params\[/i,
    hint:     'Mass assignment: passing raw params to update/create without strong parameters (permit). Use params.require().permit().',
    exts:     ['.rb'],
  },
  {
    id:       'ruby-todo-fixme',
    severity: 'info',
    pattern:  /#\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.rb'],
  },

  // ── C# rules ──────────────────────────────────────────────────────────────────
  {
    id:       'csharp-sql-injection',
    severity: 'critical',
    pattern:  /new\s+SqlCommand\s*\(\s*(?:"[^"]*"\s*\+|string\.Format\s*\(|"[^"]*"\s*\+\s*(?:Request|HttpContext))/i,
    hint:     'C# SQL injection: query built with string concatenation. Use SqlParameter or an ORM with parameterised queries.',
    exts:     ['.cs'],
  },
  {
    id:       'csharp-xxe',
    severity: 'critical',
    pattern:  /new\s+XmlDocument\s*\(\s*\)|XmlReader\.Create\s*\([^)]*\)/i,
    hint:     'XXE risk: XML parser without ProhibitDtd=true or XmlResolver=null. Disable external entity resolution.',
    exts:     ['.cs'],
  },
  {
    id:       'csharp-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|apiKey|connectionString|token)\s*=\s*"[^"]{8,}"/i,
    hint:     'Hardcoded credential in C#. Use environment variables, Azure Key Vault, or secrets.json.',
    exts:     ['.cs'],
  },
  {
    id:       'csharp-open-redirect',
    severity: 'high',
    pattern:  /Response\.Redirect\s*\(\s*(?:Request\.|HttpContext\.)/i,
    hint:     'Open redirect in ASP.NET: redirecting to a user-supplied URL. Validate with Url.IsLocalUrl().',
    exts:     ['.cs'],
  },
  {
    id:       'csharp-todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.cs'],
  },

  // ── Rust rules ────────────────────────────────────────────────────────────────
  {
    id:       'rust-command-injection',
    severity: 'critical',
    pattern:  /Command::new\s*\(\s*(?:&user_input|&args|format!)/i,
    hint:     'Command injection: user-controlled data in std::process::Command. Pass arguments as separate .arg() calls.',
    exts:     ['.rs'],
  },
  {
    id:       'rust-unsafe-block',
    severity: 'high',
    pattern:  /\bunsafe\s*\{/,
    hint:     'unsafe block detected — review carefully for memory safety violations (raw pointer derefs, FFI calls).',
    exts:     ['.rs'],
  },
  {
    id:       'rust-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|api_key|token|private_key)\s*(?:=|:)\s*"[^"]{8,}"/i,
    hint:     'Hardcoded credential in Rust. Use std::env::var() or the `dotenv` crate.',
    exts:     ['.rs'],
  },
  {
    id:       'rust-todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX|todo!|unimplemented!)/i,
    hint:     'Unresolved TODO/FIXME or todo!()/unimplemented!() macro.',
    exts:     ['.rs'],
  },
  // ── C / C++ rules ─────────────────────────────────────────────────────────────
  {
    id:       'c-buffer-overflow',
    severity: 'critical',
    pattern:  /\b(?:gets|strcpy|strcat|sprintf|scanf)\s*\(/,
    hint:     'Unsafe C string function with no bounds checking — use gets_s, strncpy, strncat, snprintf, or fgets instead.',
    exts:     ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp'],
  },
  {
    id:       'c-format-string',
    severity: 'critical',
    pattern:  /printf\s*\(\s*(?!["'])|\bsprintf\s*\(\s*\w+\s*,\s*(?!["'])/,
    hint:     'Format string vulnerability: first argument to printf/sprintf is a variable, not a literal. An attacker can control the format string.',
    exts:     ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp'],
  },
  {
    id:       'c-command-injection',
    severity: 'critical',
    pattern:  /\bsystem\s*\(|popen\s*\(/,
    hint:     'Command injection risk: system()/popen() with user-controlled input executes shell commands. Use exec family functions with argument arrays.',
    exts:     ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp'],
  },
  {
    id:       'c-integer-overflow',
    severity: 'high',
    pattern:  /\b(?:atoi|atol|atoll)\s*\(/,
    hint:     'atoi/atol/atoll does not detect overflow and returns 0 on error with no indication. Use strtol/strtoll with error checking.',
    exts:     ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp'],
  },
  {
    id:       'c-use-after-free',
    severity: 'high',
    pattern:  /free\s*\(\s*(\w+)\s*\).*\n(?:.*\n){0,5}.*\1\s*(?:\[|\.|->|->\w)/,
    hint:     'Potential use-after-free: memory accessed after free(). Set pointer to NULL after freeing.',
    exts:     ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp'],
  },
  {
    id:       'cpp-new-no-check',
    severity: 'medium',
    pattern:  /=\s*new\s+\w[\w:<>*\s]*(?:\[.*?\])?\s*(?:\([^)]*\))?\s*;/,
    hint:     'C++ `new` without nothrow — throws std::bad_alloc on failure. Wrap in try/catch or use new(std::nothrow) with a null check.',
    exts:     ['.cpp', '.cc', '.cxx', '.hpp'],
  },
  {
    id:       'c-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|api_key|token|private_key)\s*(?:=|\[\])\s*"[^"]{8,}"/i,
    hint:     'Hardcoded credential in C/C++. Use environment variables or a secure keystore at runtime.',
    exts:     ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp'],
  },
  {
    id:       'c-todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp'],
  },

  // ── Kotlin rules ──────────────────────────────────────────────────────────────
  {
    id:       'kotlin-sql-injection',
    severity: 'critical',
    pattern:  /(?:rawQuery|execSQL)\s*\(\s*(?:"[^"]*"\s*\+|\$\{|""".*\$)/i,
    hint:     'Kotlin SQL injection: string interpolation in rawQuery/execSQL. Use parameterised queries with ? placeholders.',
    exts:     ['.kt', '.kts'],
  },
  {
    id:       'kotlin-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|apiKey|api_key|token|privateKey)\s*(?:=|:)\s*"[^"]{8,}"/i,
    hint:     'Hardcoded credential in Kotlin. Use BuildConfig fields, Android Keystore, or environment variables.',
    exts:     ['.kt', '.kts'],
  },
  {
    id:       'kotlin-logging-sensitive',
    severity: 'medium',
    pattern:  /Log\.[dvwie]\s*\([^,]+,\s*(?:password|token|secret|key|auth)/i,
    hint:     'Sensitive data logged via Android Log — logs are readable by other apps on rooted devices.',
    exts:     ['.kt', '.kts'],
  },
  {
    id:       'kotlin-implicit-intent',
    severity: 'medium',
    pattern:  /Intent\s*\(\s*\)\s*\.setAction|sendBroadcast\s*\(\s*Intent\s*\(\s*\)/i,
    hint:     'Implicit Intent may be intercepted by malicious apps. Use explicit Intents with a specific component.',
    exts:     ['.kt', '.kts'],
  },
  {
    id:       'kotlin-todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.kt', '.kts'],
  },

  // ── Swift rules ───────────────────────────────────────────────────────────────
  {
    id:       'swift-sql-injection',
    severity: 'critical',
    pattern:  /(?:sqlite3_exec|executeQuery|executeUpdate)\s*\(\s*(?:db,\s*)?["'][^"']*\\\(|["'][^"']*"\s*\+/i,
    hint:     'Swift SQL injection: string interpolation in SQL query. Use parameterised statements with ? or named bindings.',
    exts:     ['.swift'],
  },
  {
    id:       'swift-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|apiKey|api_key|token|privateKey)\s*(?:=|:)\s*"[^"]{8,}"/i,
    hint:     'Hardcoded credential in Swift. Use Keychain Services or environment configuration instead.',
    exts:     ['.swift'],
  },
  {
    id:       'swift-force-unwrap',
    severity: 'medium',
    pattern:  /\w+!\s*(?:\.|\.?\[|$)/,
    hint:     'Force unwrap (!) on optional — will crash at runtime if nil. Use guard let, if let, or ?? instead.',
    exts:     ['.swift'],
  },
  {
    id:       'swift-http-not-https',
    severity: 'high',
    pattern:  /URL\s*\(\s*string:\s*"http:\/\//i,
    hint:     'Plain HTTP URL in Swift — use HTTPS. Also review App Transport Security settings in Info.plist.',
    exts:     ['.swift'],
  },
  {
    id:       'swift-logging-sensitive',
    severity: 'medium',
    pattern:  /print\s*\([^)]*(?:password|token|secret|key|auth)/i,
    hint:     'Sensitive data in print() — visible in device logs. Use os_log with privacy metadata in production.',
    exts:     ['.swift'],
  },
  {
    id:       'swift-todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.swift'],
  },

  // ── HTML rules ────────────────────────────────────────────────────────────────
  {
    id:       'html-inline-script',
    severity: 'medium',
    pattern:  /<script[^>]*>[^<]{20,}/i,
    hint:     'Inline <script> block — move to an external .js file and add a strict Content-Security-Policy to prevent XSS.',
    exts:     ['.html', '.htm', '.xhtml'],
  },
  {
    id:       'html-inline-handler',
    severity: 'medium',
    pattern:  /\bon(?:click|load|error|mouseover|submit|keyup|keydown|change)\s*=/i,
    hint:     'Inline event handler (onclick, onload, etc.) — these bypass Content-Security-Policy. Move logic to addEventListener().',
    exts:     ['.html', '.htm', '.xhtml'],
  },
  {
    id:       'html-http-link',
    severity: 'medium',
    pattern:  /(?:src|href|action)\s*=\s*["']http:\/\//i,
    hint:     'Plain HTTP URL in HTML attribute — upgrade to HTTPS to prevent mixed-content and MITM attacks.',
    exts:     ['.html', '.htm', '.xhtml'],
  },
  {
    id:       'html-autocomplete-password',
    severity: 'low',
    pattern:  /type\s*=\s*["']password["'][^>]*(?!autocomplete\s*=\s*["']off["'])|<input[^>]*autocomplete\s*=\s*["']on["'][^>]*type\s*=\s*["']password/i,
    hint:     'Password input without autocomplete="off" — browsers may cache credentials.',
    exts:     ['.html', '.htm', '.xhtml'],
  },
  {
    id:       'html-todo-fixme',
    severity: 'info',
    pattern:  /<!--\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME in HTML comment.',
    exts:     ['.html', '.htm', '.xhtml'],
  },

  // ── CSS rules ────────────────────────────────────────────────────────────────
  {
    id:       'css-expression',
    severity: 'critical',
    pattern:  /expression\s*\(/i,
    hint:     'CSS expression() is an IE-era feature that executes JavaScript from stylesheets — XSS vector. Remove entirely.',
    exts:     ['.css', '.scss', '.sass', '.less'],
  },
  {
    id:       'css-import-external',
    severity: 'medium',
    pattern:  /@import\s+(?:url\s*\(\s*)?["']?https?:\/\//i,
    hint:     'External CSS @import — a compromised CDN can inject malicious styles. Self-host critical stylesheets.',
    exts:     ['.css', '.scss', '.sass', '.less'],
  },
  {
    id:       'css-todo-fixme',
    severity: 'info',
    pattern:  /\/\*\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME in CSS comment.',
    exts:     ['.css', '.scss', '.sass', '.less'],
  },

  // ── Shell script rules ────────────────────────────────────────────────────────
  {
    id:       'shell-command-injection',
    severity: 'critical',
    pattern:  /(?:eval|exec)\s+(?:\$|`)/,
    hint:     'Shell command injection: eval/exec with a variable or subshell. An attacker who controls the variable gets code execution.',
    exts:     ['.sh', '.bash', '.zsh', '.fish'],
  },
  {
    id:       'shell-curl-pipe',
    severity: 'high',
    pattern:  /curl\s+[^|]*\|\s*(?:bash|sh|zsh|python|ruby|node)/i,
    hint:     'curl-pipe-to-shell pattern: downloads and immediately executes code. Verify the download separately before executing.',
    exts:     ['.sh', '.bash', '.zsh', '.fish'],
  },
  {
    id:       'shell-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:PASSWORD|SECRET|API_KEY|TOKEN|PRIVATE_KEY)\s*=\s*["']?[A-Za-z0-9+/=_\-]{8,}["']?/,
    hint:     'Hardcoded credential in shell script. Use a secrets manager or source from a .env file excluded from version control.',
    exts:     ['.sh', '.bash', '.zsh', '.fish'],
  },
  {
    id:       'shell-world-writable',
    severity: 'medium',
    pattern:  /chmod\s+(?:0?777|a\+w|go\+w)/,
    hint:     'World-writable file permissions (777 / a+w) — any user on the system can modify this file.',
    exts:     ['.sh', '.bash', '.zsh', '.fish'],
  },
  {
    id:       'shell-todo-fixme',
    severity: 'info',
    pattern:  /#\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME in shell comment.',
    exts:     ['.sh', '.bash', '.zsh', '.fish'],
  },

  // ── Dart / Flutter rules ──────────────────────────────────────────────────────
  {
    id:       'dart-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|apiKey|api_key|token|privateKey)\s*(?:=|:)\s*['"][^'"]{8,}['"];/i,
    hint:     'Hardcoded credential in Dart/Flutter. Use flutter_secure_storage or environment config; never bake secrets into the APK/IPA.',
    exts:     ['.dart'],
  },
  {
    id:       'dart-http-not-https',
    severity: 'high',
    pattern:  /Uri\.parse\s*\(\s*['"]http:\/\//i,
    hint:     'Plain HTTP URI in Dart — use HTTPS. Android P+ blocks cleartext by default.',
    exts:     ['.dart'],
  },
  {
    id:       'dart-logging-sensitive',
    severity: 'medium',
    pattern:  /print\s*\([^)]*(?:password|token|secret|key|auth)/i,
    hint:     'Sensitive data in print() — visible in debug console and device logs. Strip before production release.',
    exts:     ['.dart'],
  },
  {
    id:       'dart-todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.dart'],
  },

  // ── Scala rules ───────────────────────────────────────────────────────────────
  {
    id:       'scala-sql-injection',
    severity: 'critical',
    pattern:  /(?:executeQuery|executeUpdate|execute)\s*\(\s*(?:s["']|["'][^"']*"\s*\+)/i,
    hint:     'Scala SQL injection: string interpolation or concatenation in query. Use Slick, Doobie, or parameterised JDBC.',
    exts:     ['.scala'],
  },
  {
    id:       'scala-hardcoded-secret',
    severity: 'high',
    pattern:  /(?:password|secret|apiKey|api_key|token|privateKey)\s*(?:=|:)\s*"[^"]{8,}"/i,
    hint:     'Hardcoded credential in Scala. Use Typesafe Config with environment variable substitution.',
    exts:     ['.scala'],
  },
  {
    id:       'scala-todo-fixme',
    severity: 'info',
    pattern:  /\/\/\s*(?:TODO|FIXME|HACK|XXX)/i,
    hint:     'Unresolved TODO/FIXME comment.',
    exts:     ['.scala'],
  },
];

// ── Binary / oversized file guard ─────────────────────────────────────────────
// Files matching these patterns are skipped before scanning.
const BINARY_EXTENSIONS = new Set([
  '.pyc', '.pyo', '.class', '.jar', '.war', '.ear',
  '.exe', '.dll', '.so', '.dylib', '.obj', '.o',
  '.wasm', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp',
  '.mp3', '.mp4', '.wav', '.ogg', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.lock',   // package-lock.json is text but has no security value
]);

// Files larger than this are skipped (likely generated/minified)
const MAX_FILE_BYTES = 500 * 1024; // 500 KB

// Lines longer than this indicate a minified file — skip the whole file
const MAX_LINE_LENGTH = 2000;

/**
 * Returns true if a file should be skipped for scanning.
 */
function shouldSkipFile(filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (stat && stat.size > MAX_FILE_BYTES) return true;
  return false;
}

/**
 * Returns true if the file content looks minified (any line > MAX_LINE_LENGTH).
 */
function isMinified(src) {
  const newline = src.indexOf('\n');
  // If the first line is very long, treat as minified
  const firstLine = newline === -1 ? src : src.slice(0, newline);
  return firstLine.length > MAX_LINE_LENGTH;
}

/**
 * Runs all rules against src line-by-line.
 * Skips rules whose `exts` array doesn't include the file's extension.
 * Returns an array of finding objects.
 */
function runAstRules(filePath, src) {
  if (isMinified(src)) return []; // skip minified files silently

  const ext      = path.extname(filePath).toLowerCase();
  const lines    = src.split('\n');
  const findings = [];
  for (const rule of AST_RULES) {
    // If the rule declares an extension filter, skip it for other file types
    if (rule.exts && !rule.exts.includes(ext)) continue;
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
 * Recursively collects files matching `extensions` under `dir`.
 * `excludeDirs` is an optional array of directory names to skip
 * (in addition to the built-in defaults).
 * Skips binary files and files over MAX_FILE_BYTES.
 */
const DEFAULT_SKIP = new Set([
  'node_modules', 'build', '.git', 'dist', 'coverage',
  '.breakpoint', '__pycache__', '.venv', '.venv-clean',
  '.idea', '.mypy_cache', '.pytest_cache', '.tox', 'venv', 'env',
  'vendor',   // Go, PHP, Ruby
  'target',   // Rust, Java/Maven
  'bin', 'obj', // .NET
  '.gradle', '.mvn', // Java build tools
  'Pods',     // iOS
]);

function collectSourceFiles(dir, extensions, excludeDirs) {
  const results  = [];
  const skipDirs = new Set([...DEFAULT_SKIP, ...(excludeDirs || [])]);

  // Normalise extensions to lowercase for case-insensitive matching
  const normExts = extensions
    ? extensions.map(e => e.toLowerCase())
    : null;

  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current); } catch { return; }
    for (const entry of entries) {
      if (skipDirs.has(entry)) continue;
      const full = path.join(current, entry);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const ext = path.extname(entry).toLowerCase();
        if (normExts && !normExts.includes(ext)) continue;
        if (shouldSkipFile(full, stat)) continue;
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Returns the set of all file extensions the scanner has rules for.
 * Useful for auto-populating breakpoint.config.json extensions.
 */
function getSupportedExtensions() {
  const exts = new Set();
  for (const rule of AST_RULES) {
    if (rule.exts) rule.exts.forEach(e => exts.add(e));
  }
  return [...exts].sort();
}

module.exports = { runAstRules, collectSourceFiles, AST_RULES, shouldSkipFile, getSupportedExtensions };
