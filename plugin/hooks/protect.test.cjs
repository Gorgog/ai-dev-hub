// Protection modules of slice 13 (protect.cjs + pretool.d/3x-*.cjs): event in → decision out.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const P = require('./protect.cjs');

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: clean, stdio: ['ignore', 'pipe', 'pipe'] });

// A repo with a committed migration, an existing .env, a lockfile and their harmless neighbours.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-'));
  const files = {
    '.env': 'KEY=1\n', '.env.local': 'KEY=2\n', '.env.example': 'KEY=\n', 'package.json': '{}\n', 'package-lock.json': '{}\n',
    'pnpm-lock.yaml': 'x\n', 'prisma/migrations/20240101_init/migration.sql': 'create table a();\n', 'src/a.ts': 'x\n',
    'db/migrations/001_init.sql': 'create table b();\n', 'notes.md': 'x\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'add', '--', ...Object.keys(files));
  git(dir, '-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  // a new migration on disk, not yet committed — allowed
  fs.writeFileSync(path.join(dir, 'db/migrations/002_new.sql'), 'alter table b add c int;\n');
  return dir;
}
const R = repo();
const edit = (rel, tool = 'Edit', extra = {}) => ({ tool_name: tool, cwd: R, tool_input: { file_path: path.join(R, rel), ...extra }, ...extra.ev });
const bash = (command, ev = {}) => ({ tool_name: 'Bash', cwd: R, tool_input: { command }, ...ev });
const deny = (res, re, msg) => {
  assert.ok(res && res.decision === 'deny', `${msg || ''} ждали deny, вышло ${JSON.stringify(res)}`);
  if (re) assert.match(res.reason, re);
};
const quiet = (res, msg) => assert.strictEqual(res, null, `${msg || ''} ждали тишину, вышло ${JSON.stringify(res)}`);

// --- protect-files -------------------------------------------------------------------------------------------------

test('protect-files: правка существующего .env, .env.local — deny; .env.example и новый .env — можно', () => {
  deny(P.protectFiles(edit('.env')), /\.env/);
  deny(P.protectFiles(edit('.env.local', 'Write')), /\.env/);
  quiet(P.protectFiles(edit('.env.example')));
  quiet(P.protectFiles(edit('sub/.env', 'Write')), 'нового .env нет на диске:');
  quiet(P.protectFiles(edit('src/a.ts')));
});

test('protect-files: локфайлы — deny, package.json — можно', () => {
  deny(P.protectFiles(edit('package-lock.json')), /лок/i);
  deny(P.protectFiles(edit('pnpm-lock.yaml', 'MultiEdit')), /лок/i);
  quiet(P.protectFiles(edit('package.json')));
});

test('protect-files: миграция из HEAD — deny; новая миграция — можно', () => {
  deny(P.protectFiles(edit('prisma/migrations/20240101_init/migration.sql')), /миграц/i);
  deny(P.protectFiles(edit('db/migrations/001_init.sql', 'Write')), /миграц/i);
  quiet(P.protectFiles(edit('db/migrations/002_new.sql')), 'на диске, но не в HEAD:');
  quiet(P.protectFiles(edit('db/migrations/003_more.sql', 'Write')), 'ещё нет на диске:');
});

test('protect-files: Bash — запись в защищённый файл deny, чтение и текст — тишина', () => {
  deny(P.protectFiles(bash('echo KEY=3 >> .env')), /\.env/);
  deny(P.protectFiles(bash("sed -i 's/a/b/' package-lock.json")), /лок/i);
  deny(P.protectFiles(bash('rm db/migrations/001_init.sql')), /миграц/i);
  deny(P.protectFiles(bash('cp .env.example .env')), /\.env/, 'цель cp существует:');
  deny(P.protectFiles(bash(`printf 'x' | tee -a ${R}/.env.local >/dev/null`)), /\.env/);
  deny(P.protectFiles(bash('( cd prisma && echo x > migrations/20240101_init/migration.sql )')), /миграц/i, 'путь от cd:');
  quiet(P.protectFiles(bash('cat .env && grep KEY .env.local')));
  quiet(P.protectFiles(bash('git diff package-lock.json && git add package-lock.json')));
  quiet(P.protectFiles(bash('echo ".env" >> notes.md')));
  quiet(P.protectFiles(bash('git commit -m "fix > .env handling"')));
  quiet(P.protectFiles(bash("cat >> notes.md <<'EOF'\necho x > .env\nEOF")), 'текст heredoc:');
  quiet(P.protectFiles(bash('cp .env.example sub/.env')), 'цели нет:');
  quiet(P.protectFiles(bash('npm test 2>&1 >/dev/null')));
});

// --- inline-script --------------------------------------------------------------------------------------------------

test('inline-script: node -e "…" с обратными кавычками — deny с готовой командой', () => {
  const body = 'const s = `a`; console.log(s)';
  const res = P.inlineScript(bash(`node -e "${body}" one two`));
  deny(res, /Write/);
  const m = res.reason.match(/`(node \S+\.cjs one two)`/);
  assert.ok(m, `нет готовой команды: ${res.reason}`);
  assert.ok(m[1].split(' ')[1].startsWith(P.SCRIPTS_DIR + path.sep), m[1]);
});

test('inline-script: python heredoc без кавычек с `\\` — deny, команда — python3 <файл>', () => {
  const res = P.inlineScript(bash("python3 - <<EOF\nimport re\nprint(re.sub(r'\\\\d+', '', 'a1'))\nEOF"));
  deny(res, /`python3 \S+\.py`/);
});

test('inline-script: heredoc в интерпретатор с флагами и выводом в файл — путь после флагов', () => {
  const res = P.inlineScript(bash('node --input-type=module <<EOF > out.txt\nconsole.log(`x`)\nEOF'));
  deny(res, /`node --input-type=module \S+\.mjs > out\.txt`/);
});

test('inline-script: perl -pi -e в двойных кавычках с `\\` — deny, флаг e уходит из связки', () => {
  deny(P.inlineScript(bash('perl -pi -e "s/\\\\s+//" notes.md')), /`perl -pi \S+\.pl notes\.md`/);
});

test('inline-script: внутри $( ) тоже; ${…} — не параметр shell', () => {
  deny(P.inlineScript(bash('x=$(node -e "console.log(`a`)") && echo "$x"')));
  deny(P.inlineScript(bash('node -e "const o = {a: 1}; console.log(\'${o.a}\')"')), null, 'bad substitution:');
});

test('inline-script: код в файл через cat > *.py <<EOF без кавычек с `\\` — deny, совет Write в этот файл', () => {
  deny(P.inlineScript(bash('cat > fix.py <<EOF\nprint("a\\\\n")\nEOF')), /Write[^\n]*fix\.py/);
});

test('inline-script: shell тела не трогает или трогает намеренно — тишина', () => {
  quiet(P.inlineScript(bash('node -e "console.log(1 + 1)"')));
  quiet(P.inlineScript(bash("node -e 'console.log(require(\"./package.json\").name)'")));
  quiet(P.inlineScript(bash("python3 -c \"import json,sys; print(json.load(sys.stdin)['a'])\" < f.json")));
  quiet(P.inlineScript(bash("python3 - <<'EOF'\nimport re\nprint(re.sub(r'\\d+', '', `a1`))\nEOF")), '<<\'EOF\' — тело как есть:');
  quiet(P.inlineScript(bash("perl -pi -e 's/\\s+$//' notes.md")), "'…' — тело как есть:");
  quiet(P.inlineScript(bash("cat > fix.py <<'EOF'\nprint(\"a\\\\n\")\nEOF")), "cat > *.py <<'EOF':");
  quiet(P.inlineScript(bash('node -e "console.log(require(\'$M/x.json\').a, \\"${HOME}\\")"')), '$M и ${HOME} — подстановка намеренная:');
  quiet(P.inlineScript(bash('node -e "console.log(\\`x\\`)"')), 'обратная кавычка экранирована:');
  quiet(P.inlineScript(bash("git commit -q -m \"$(cat <<'EOF'\nfix: `x` \\ y ${z}\nEOF\n)\"")), 'heredoc сообщения коммита:');
  quiet(P.inlineScript(bash("cat >> notes.md <<EOF\n`code` \\\\ ${x.y}\nEOF")), 'текст в .md:');
  quiet(P.inlineScript(bash('node scripts/fix.cjs --flag "a\\\\b"')), 'скрипт файлом:');
  quiet(P.inlineScript(bash("echo 'node -e \"`x`\"'")), 'команда в тексте echo:');
  quiet(P.inlineScript(bash('grep -rn "node -e" docs/')));
});

// --- agent-model ----------------------------------------------------------------------------------------------------

const agent = (input, tool = 'Agent') => ({ tool_name: tool, cwd: R, tool_input: { description: 'review', prompt: 'p', ...input } });

test('agent-model: ревьюер с моделью не opus — deny с вызовом без model', () => {
  deny(P.agentModel(agent({ subagent_type: 'hub:reviewer', model: 'sonnet' })), /без `?model/);
  deny(P.agentModel(agent({ subagent_type: 'reviewer', model: 'fable' }, 'Task')), /opus/i);
});

// Journal of the session: records as Claude Code writes them (origin.kind human / peer / task-notification).
const human = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const records = {
  toolResult: (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } }),
  peer: (text) => ({ type: 'user', isMeta: true, origin: { kind: 'peer', from: 'local_x' }, message: { role: 'user', content: `<cross-session-message from="local_x">${text}</cross-session-message>` } }),
  task: (text) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: `<task-notification>${text}</task-notification>` } }),
  assistant: (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
};
function transcript(...recs) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tr-')), 's.jsonl');
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const reviewerOn = (model, transcript_path) => ({ ...agent({ subagent_type: 'hub:reviewer', model }), ...(transcript_path ? { transcript_path } : {}) });

test('agent-model: модель названа в последнем сообщении пользователя — можно (и кириллицей)', () => {
  quiet(P.agentModel(reviewerOn('sonnet', transcript(human('Сделай ревью на Sonnet, Opus сейчас занят'), records.assistant('Запускаю')))));
  quiet(P.agentModel(reviewerOn('fable', transcript(human('ревьюера гони на фейбле')))));
  quiet(P.agentModel(reviewerOn('haiku', transcript(human('пусть ревьюер будет хайку'), records.toolResult('ok'), records.task('done')))),
    'после сообщения — только служебные записи:');
  quiet(P.agentModel(reviewerOn('sonnet', transcript(human([{ type: 'text', text: 'ревью — соннетом' }])))), 'content массивом:');
});

test('agent-model: модель не из последнего сообщения человека — deny', () => {
  const why = /другая модель — только если пользователь назовёт её сам/;
  deny(P.agentModel(reviewerOn('sonnet', transcript(human('сделай ревью'), records.toolResult('model: sonnet')))), why, 'в выводе инструмента:');
  deny(P.agentModel(reviewerOn('sonnet', transcript(human('сделай ревью'), records.peer('ревьюер на sonnet')))), why, 'в сообщении другой сессии:');
  deny(P.agentModel(reviewerOn('sonnet', transcript(human('сделай ревью'), records.task('sonnet')))), why, 'в уведомлении задачи:');
  deny(P.agentModel(reviewerOn('sonnet', transcript(human('ревью на sonnet'), records.assistant('ок'), human('теперь ещё раз')))), why,
    'названа раньше, не в последнем:');
  deny(P.agentModel(reviewerOn('sonnet', transcript(human('<system-reminder>tester: model sonnet</system-reminder>\nсделай ревью')))), why,
    'только во вклеенном system-reminder:');
  deny(P.agentModel(reviewerOn('haiku', transcript(human('ревью на sonnet')))), why, 'названа другая модель:');
  deny(P.agentModel(reviewerOn('sonnet')), why, 'нет transcript_path:');
  deny(P.agentModel(reviewerOn('sonnet', path.join(os.tmpdir(), 'no-such-transcript.jsonl'))), why, 'транскрипт не читается:');
});

test('agent-model: ревьюер без model или на opus, другие агенты — тишина', () => {
  quiet(P.agentModel(agent({ subagent_type: 'hub:reviewer' })));
  quiet(P.agentModel(agent({ subagent_type: 'hub:reviewer', model: 'opus' })));
  quiet(P.agentModel(agent({ subagent_type: 'general-purpose', model: 'haiku' })));
  quiet(P.agentModel(bash('echo reviewer')));
});

// --- agent-roles ----------------------------------------------------------------------------------------------------

const HUB = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-hub-'));
const ctx = { hub: HUB };
const as = (agent_type, ev) => ({ ...ev, agent_type });

test('agent-roles: ревьюер и разведчик файлов не пишут', () => {
  deny(P.agentRoles(as('hub:reviewer', edit('src/a.ts', 'Write')), ctx), /ревьюер/i);
  deny(P.agentRoles(as('explorer', edit('src/a.ts')), ctx));
  deny(P.agentRoles(as('hub:reviewer', bash('git diff main..HEAD > review.txt')), ctx), /review\.txt/);
  deny(P.agentRoles(as('reviewer', bash('git stash push -m x')), ctx), /git stash/);
  deny(P.agentRoles(as('hub:reviewer', bash(`git -C ${R} commit -m x`)), ctx), /git commit/);
  deny(P.agentRoles(as('hub:reviewer', bash("sed -i 's/a/b/' src/a.ts && npm test; git checkout -- src/a.ts")), ctx), /src\/a\.ts/, 'мутация в дереве автора:');
  deny(P.agentRoles(as('hub:tester', bash('git stash push -u -- src')), ctx), /git stash/);
  quiet(P.agentRoles(as('hub:reviewer', bash('S=/tmp/rv-scratch; mkdir -p "$S" && git -C "$S" init -q && git -C $S commit -qm x; git init -q -b main $S/r')), ctx), 'свой репозиторий в /tmp:');
  quiet(P.agentRoles(as('hub:reviewer', bash('git -C "$UNKNOWN" commit -m x')), ctx), 'место неизвестно — не судим:');
  quiet(P.agentRoles(as('hub:reviewer', bash('git diff main..HEAD > /tmp/x.diff && git log --oneline -3')), ctx));
  quiet(P.agentRoles(as('hub:reviewer', bash('node --test src/a.test.cjs 2>&1 | tail -5')), ctx));
  quiet(P.agentRoles(as('hub:explorer', bash('grep -rn foo src 2>/dev/null')), ctx));
  const scratch = { tool_name: 'Write', cwd: R, tool_input: { file_path: path.join(os.tmpdir(), 'claude-x', 'scratchpad', 'notes.md') } };
  quiet(P.agentRoles(as('hub:explorer', scratch), ctx), 'заметка в scratchpad:');
  quiet(P.agentRoles(as('hub:reviewer', scratch), ctx), 'заметка в scratchpad:');
});

test('agent-roles: тестировщик пишет только тесты', () => {
  quiet(P.agentRoles(as('hub:tester', edit('src/a.test.ts', 'Write')), ctx));
  quiet(P.agentRoles(as('tester', edit('tests/helpers/db.ts')), ctx));
  quiet(P.agentRoles(as('hub:tester', edit('app/__tests__/x.tsx', 'Write')), ctx));
  quiet(P.agentRoles(as('hub:tester', edit('tools/test_parse.py', 'Write')), ctx));
  deny(P.agentRoles(as('hub:tester', edit('src/a.ts')), ctx), /тест/i);
  deny(P.agentRoles(as('hub:tester', bash("sed -i 's/a/b/' src/a.ts")), ctx), /src\/a\.ts/);
  quiet(P.agentRoles(as('hub:tester', bash('npm test > /tmp/out.log 2>&1')), ctx));
  quiet(P.agentRoles(as('hub:tester', { tool_name: 'Write', cwd: R, tool_input: { file_path: path.join(os.tmpdir(), 'tester-notes.md') } }), ctx), 'вне репозитория:');
});

test('agent-roles: память агента в рабочем репозитории — deny всем; память хаба — deny ролям', () => {
  deny(P.agentRoles(edit('.claude/agent-memory/reviewer/MEMORY.md', 'Write'), ctx), /agent-memory/);
  deny(P.agentRoles(as('general-purpose', bash('echo x >> .claude/agent-memory/r.md')), ctx), /agent-memory/);
  const mem = { tool_name: 'Write', cwd: R, tool_input: { file_path: path.join(HUB, 'projects', 'demo', 'memory', 'errors.md') } };
  deny(P.agentRoles(as('hub:tester', mem), ctx), /памят/i);
  quiet(P.agentRoles(mem, ctx), 'основная сессия пишет память хаба:');
  quiet(P.agentRoles(edit('src/a.ts', 'Write'), ctx), 'основная сессия пишет код:');
  quiet(P.agentRoles(as('general-purpose', edit('src/a.ts', 'Write')), ctx));
});

// --- review round 1 -------------------------------------------------------------------------------------------------

const { spawnSync } = require('child_process');
// A committed repo under <tmp>/<parents…>/repo with the given files.
function repoUnder(parents, files) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'protect-up-')), ...parents, 'repo');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'add', '--', ...Object.keys(files));
  git(dir, '-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return dir;
}
// Run the ready command of an inline-script deny: write `body` to the file it names, run the command in cwd.
function runReady(res, body, cwd, input) {
  const file = res.reason.match(/Write в (\S+) /)[1];
  const cmd = res.reason.match(/выполни Bash: `([^`]+)`/)[1];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', input, env: clean });
  return (r.stdout + r.stderr).trim();
}

test('ревью H1: готовая команда inline-script выполняется — модули от cwd, stdin и флаги сохранены', () => {
  const dir = repoUnder([], { 'package.json': '{"version":"1.2.3"}\n', 'mymod.py': 'X = 5\n' });
  const ev = (command) => ({ tool_name: 'Bash', cwd: dir, tool_input: { command } });
  const nodeBody = "const p=require('./package.json'); console.log(`v${p.version}`)";
  assert.strictEqual(runReady(P.inlineScript(ev(`node -e "${nodeBody}"`)), nodeBody, dir), 'v1.2.3');
  const stdinBody = "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).a, `x`))";
  assert.strictEqual(runReady(P.inlineScript(ev(`node -e "${stdinBody}"`)), stdinBody, dir, '{"a":7}'), '7 x', 'stdin данных — на месте');
  const py = P.inlineScript(ev('python3 - one <<EOF\nfrom mymod import X\nprint(X, "a\\\\b")\nEOF'));
  assert.strictEqual(runReady(py, 'import sys\nfrom mymod import X\nprint(X, sys.argv[1])\n', dir), '5 one');
  const pl = P.inlineScript(ev('perl -E "say \'a\\\\b\'"'));
  assert.strictEqual(runReady(pl, "say 'ok'\n", dir), 'ok', '-E сохранён (say)');
});

test('ревью H2, L1: экранированный \\${…} и $\'…\' — тишина', () => {
  quiet(P.inlineScript(bash('node -e "const o={a:1}; console.log(\\`v\\${o.a}\\`)"')));
  quiet(P.inlineScript(bash("node -e $'console.log(`a`)'")));
});

test('ревью M1: миграция — по пути от корня репозитория и не документация', () => {
  const up = repoUnder(['migrations'], { 'src/a.ts': 'x\n', 'docs/migrations/guide.md': '# how\n', 'db/migrations/001.sql': 'x\n' });
  const ed = (rel) => ({ tool_name: 'Edit', cwd: up, tool_input: { file_path: path.join(up, rel) } });
  quiet(P.protectFiles(ed('src/a.ts')), 'папка migrations выше корня:');
  quiet(P.protectFiles(ed('docs/migrations/guide.md')), 'документация:');
  deny(P.protectFiles(ed('db/migrations/001.sql')), /миграц/i);
});

test('ревью M2: cd в неизвестное место — относительные пути не судятся', () => {
  quiet(P.agentRoles(as('hub:reviewer', bash('cd "$(mktemp -d)" && git init -q && git commit -q --allow-empty -m x')), ctx));
  quiet(P.agentRoles(as('hub:reviewer', bash('cd $(mktemp -d) && echo x > probe.txt')), ctx));
});

test('ревью M3: чтение git — не запись', () => {
  for (const c of ["git tag -l 'v*'", 'git tag --contains HEAD', 'git apply --check /tmp/x.diff', 'git notes', 'git stash list']) {
    quiet(P.agentRoles(as('hub:explorer', bash(c)), ctx), `${c}:`);
  }
  deny(P.agentRoles(as('hub:reviewer', bash('git tag v1')), ctx), /git tag/);
  deny(P.agentRoles(as('hub:reviewer', bash('git apply /tmp/x.diff')), ctx), /git apply/);
});

test('ревью M4: память агента — только в репозитории и только запись', () => {
  quiet(P.agentRoles(bash('rm -rf .claude/agent-memory'), ctx), 'уборка:');
  quiet(P.agentRoles(bash('echo x >> ~/.claude/agent-memory/foo/MEMORY.md'), ctx), 'память уровня пользователя:');
  deny(P.agentRoles(as('general-purpose', edit('.claude/agent-memory-local/r/MEMORY.md', 'Write')), ctx), /agent-memory/);
});

test('ревью M5: «это тест» — по пути от корня репозитория', () => {
  const up = repoUnder(['tests'], { 'src/a.ts': 'x\n', 'src/a.test.ts': 'x\n' });
  const ed = (rel) => as('hub:tester', { tool_name: 'Edit', cwd: up, tool_input: { file_path: path.join(up, rel) } });
  deny(P.agentRoles(ed('src/a.ts'), ctx), /тест/i);
  quiet(P.agentRoles(ed('src/a.test.ts'), ctx));
});

test('ревью M6, L2: git rm --cached .env и perl -Ilib — не правка', () => {
  quiet(P.protectFiles(bash('git rm --cached .env')));
  quiet(P.protectFiles(bash('perl -Ilib tools/check.pl .env')));
});

test('ревью M7: rm папки миграций и глоб — deny', () => {
  deny(P.protectFiles(bash('rm -rf prisma/migrations')), /миграц/i);
  deny(P.protectFiles(bash("sed -i 's/x/y/' prisma/migrations/*/migration.sql")), /миграц/i);
  quiet(P.protectFiles(bash('rm -rf db/migrations/002_new.sql')), 'новая, не в HEAD:');
});

test('ревью, опасения: арифметика и [[ ]] — не heredoc и не перенаправление', () => {
  deny(P.protectFiles(bash('echo $((1<<3))\necho KEY >> .env')), /\.env/);
  quiet(P.agentRoles(as('hub:reviewer', bash('[[ $a > b ]] && (( x > y )) && echo ok')), ctx));
});

test('ревью (В): модель с отрицанием — не названа', () => {
  deny(P.agentModel(reviewerOn('sonnet', transcript(human('ревью, только не на sonnet — на opus')))), /другая модель/);
  deny(P.agentModel(reviewerOn('sonnet', transcript(human('без sonnet, пожалуйста')))), /другая модель/);
  quiet(P.agentModel(reviewerOn('sonnet', transcript(human('на sonnet, не на opus')))));
});

// --- modules --------------------------------------------------------------------------------------------------------

test('модули pretool.d: id = запись реестра, run отдаёт решение механизма', () => {
  const mods = {
    'protect-files': [edit('.env'), 'pretool.d/30-protect-files.cjs'],
    'inline-script': [bash('node -e "`x`"'), 'pretool.d/31-inline-script.cjs'],
    'agent-model': [agent({ subagent_type: 'hub:reviewer', model: 'sonnet' }), 'pretool.d/32-agent-model.cjs'],
    'agent-roles': [as('hub:reviewer', edit('src/a.ts', 'Write')), 'pretool.d/33-agent-roles.cjs'],
  };
  for (const [id, [ev, file]] of Object.entries(mods)) {
    assert.ok(fs.existsSync(path.join(__dirname, file)), `нет модуля ${file}`);
    const mod = require(path.join(__dirname, file));
    assert.strictEqual(mod.id, id);
    deny(mod.run(ev, { hub: HUB }), null, `${id}:`);
    const rec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mechanisms', `${id}.json`), 'utf8'));
    assert.strictEqual(rec.file, file);
    assert.strictEqual(rec.handler, 'protect', 'один логический обработчик на срез');
    assert.strictEqual(rec.onError, 'closed');
  }
});

test('hooks.json: PreToolUse видит Agent, Task и NotebookEdit', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks.json'), 'utf8')).hooks.PreToolUse;
  for (const tool of ['Agent', 'Task', 'NotebookEdit', 'Bash', 'Edit', 'Write', 'MultiEdit']) {
    assert.ok(hooks.some((g) => new RegExp(`^(?:${g.matcher})$`).test(tool)), tool);
  }
});
