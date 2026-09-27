'use strict';
const { runAstRules, getSupportedExtensions, shouldSkipFile } = require('./lib/scan-lib');

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.log(`  ❌  ${label}  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

function fires(label, file, src, ruleId, expectedCount = 1) {
  const count = runAstRules(file, src).filter(f => f.rule === ruleId).length;
  assert(label, count, expectedCount);
}

function silent(label, file, src, ruleId) {
  fires(label, file, src, ruleId, 0);
}

// ── Extension registry ────────────────────────────────────────────────────────
console.log('\n── Supported extensions ─────────────────────────────────────');
const exts = getSupportedExtensions();
for (const e of ['.py','.java','.go','.php','.rb','.cs','.rs','.js','.ts',
                  '.c','.cpp','.h','.kt','.swift','.html','.css','.sh','.dart','.scala']) {
  assert(`has ${e}`, exts.includes(e), true);
}

// ── C / C++ ───────────────────────────────────────────────────────────────────
console.log('\n── C / C++ ──────────────────────────────────────────────────');
fires ('c-buffer-overflow fires on gets(',          'main.c',   'gets(buf);',                            'c-buffer-overflow');
fires ('c-buffer-overflow fires on strcpy(',        'util.c',   'strcpy(dst, src);',                     'c-buffer-overflow');
fires ('c-format-string fires',                     'main.c',   'printf(user_input);',                   'c-format-string');
fires ('c-command-injection fires on system(',      'main.c',   'system(cmd);',                          'c-command-injection');
fires ('c-integer-overflow fires on atoi(',         'parse.c',  'int n = atoi(argv[1]);',                'c-integer-overflow');
fires ('c-hardcoded-secret fires',                  'auth.c',   'char *password = "supersecretpw";',     'c-hardcoded-secret');
fires ('c-todo fires',                              'main.c',   '// TODO: fix this',                     'c-todo-fixme');
fires ('c-buffer-overflow fires on .cpp',           'app.cpp',  'strcpy(dst, src);',                     'c-buffer-overflow');
fires ('cpp-new-no-check fires',                    'obj.cpp',  'MyObj *p = new MyObj();',               'cpp-new-no-check');
silent('c rule silent on .py',                      'app.py',   'strcpy(dst, src);',                     'c-buffer-overflow');

// ── Kotlin ────────────────────────────────────────────────────────────────────
console.log('\n── Kotlin ───────────────────────────────────────────────────');
fires ('kotlin-sql-injection fires',                'Db.kt',    'db.rawQuery("SELECT * FROM t WHERE id=" + userId, null)', 'kotlin-sql-injection');
fires ('kotlin-hardcoded-secret fires',             'App.kt',   'val token = "ghp_abc123defg456"',       'kotlin-hardcoded-secret');
fires ('kotlin-logging-sensitive fires',            'Auth.kt',  'Log.d("tag", password)',                'kotlin-logging-sensitive');
silent('kotlin rule silent on .java',               'App.java', 'db.rawQuery("x" + id, null)',           'kotlin-sql-injection');

// ── Swift ─────────────────────────────────────────────────────────────────────
console.log('\n── Swift ────────────────────────────────────────────────────');
fires ('swift-hardcoded-secret fires',              'App.swift','let apiKey = "sk-abc1234567890xyz"',    'swift-hardcoded-secret');
fires ('swift-http-not-https fires',                'Net.swift','URL(string: "http://api.example.com")', 'swift-http-not-https');
fires ('swift-force-unwrap fires',                  'VC.swift', 'let x = foo!.bar',                     'swift-force-unwrap');
fires ('swift-logging-sensitive fires',             'Auth.swift','print("password = \\(password)")',     'swift-logging-sensitive');
silent('swift rule silent on .kt',                  'App.kt',   'URL(string: "http://x.com")',           'swift-http-not-https');

// ── HTML ──────────────────────────────────────────────────────────────────────
console.log('\n── HTML ─────────────────────────────────────────────────────');
fires ('html-inline-handler fires',                 'index.html','<button onclick="doThing()">',         'html-inline-handler');
fires ('html-http-link fires',                      'index.html','<img src="http://cdn.example.com/x">', 'html-http-link');
fires ('html-todo fires',                           'page.html', '<!-- TODO: remove this -->',           'html-todo-fixme');
silent('html rule silent on .css',                  'style.css', '<button onclick="x">',                 'html-inline-handler');

// ── CSS ───────────────────────────────────────────────────────────────────────
console.log('\n── CSS ──────────────────────────────────────────────────────');
fires ('css-expression fires',                      'style.css', 'width: expression(document.body.clientWidth)', 'css-expression');
fires ('css-import-external fires',                 'style.css', '@import url("https://evil.com/x.css")',        'css-import-external');
fires ('css-todo fires',                            'style.scss','/* TODO: fix colours */',                      'css-todo-fixme');
silent('css rule silent on .js',                    'app.js',    'expression(document.body)',                    'css-expression');

// ── Shell ─────────────────────────────────────────────────────────────────────
console.log('\n── Shell ────────────────────────────────────────────────────');
fires ('shell-command-injection fires',             'deploy.sh', 'eval $user_cmd',                       'shell-command-injection');
fires ('shell-curl-pipe fires',                     'install.sh','curl https://x.com/script | bash',     'shell-curl-pipe');
fires ('shell-hardcoded-secret fires',              'env.sh',    'API_KEY=abc123defgh456',               'shell-hardcoded-secret');
fires ('shell-world-writable fires',                'setup.sh',  'chmod 777 /var/data',                  'shell-world-writable');
silent('shell rule silent on .py',                  'run.py',    'eval $user_cmd',                       'shell-command-injection');

// ── Dart ──────────────────────────────────────────────────────────────────────
console.log('\n── Dart / Flutter ───────────────────────────────────────────');
fires ('dart-hardcoded-secret fires',               'main.dart', "const token = 'ghp_secrettoken12345';", 'dart-hardcoded-secret');
fires ('dart-http-not-https fires',                 'api.dart',  "Uri.parse('http://api.example.com')",  'dart-http-not-https');
fires ('dart-logging-sensitive fires',              'auth.dart', "print('password: $pw')",               'dart-logging-sensitive');
silent('dart rule silent on .swift',                'app.swift', "Uri.parse('http://x.com')",            'dart-http-not-https');

// ── Scala ─────────────────────────────────────────────────────────────────────
console.log('\n── Scala ────────────────────────────────────────────────────');
fires ('scala-sql-injection fires',                 'Repo.scala','stmt.executeQuery(s"SELECT * FROM t WHERE id=$id")', 'scala-sql-injection');
fires ('scala-hardcoded-secret fires',              'App.scala', 'val secret = "supersecretvalue1"',     'scala-hardcoded-secret');
silent('scala rule silent on .java',                'Repo.java', 's"SELECT * FROM t WHERE id=$id"',      'scala-sql-injection');

// ── Cross-language isolation (existing languages unaffected) ──────────────────
console.log('\n── Existing languages still work ────────────────────────────');
fires ('py-flask-debug still fires',                'app.py',    'app.run(debug=True, port=5000)',        'py-flask-debug');
fires ('java-sql-injection still fires',            'Repo.java', 'stmt.executeQuery("SELECT * FROM t WHERE id=" + req)', 'java-sql-injection');
fires ('php-xss still fires',                       'index.php', 'echo $_GET["name"];',                  'php-xss');
fires ('rust-unsafe-block still fires',             'main.rs',   'unsafe { *ptr = 42; }',                'rust-unsafe-block');

// ── Binary guard still works ──────────────────────────────────────────────────
console.log('\n── Binary guard ─────────────────────────────────────────────');
assert('skip .pyc',    shouldSkipFile('a.pyc',   { size: 100 }),    true);
assert('skip 600KB',   shouldSkipFile('a.js',    { size: 620000 }), true);
assert('allow .swift', shouldSkipFile('a.swift', { size: 10000 }),  false);
assert('allow .kt',    shouldSkipFile('a.kt',    { size: 10000 }),  false);
assert('allow .dart',  shouldSkipFile('a.dart',  { size: 10000 }),  false);

console.log(`\n${'─'.repeat(55)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
