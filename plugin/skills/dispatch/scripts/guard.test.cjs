// node --test guard.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide } = require('./guard.cjs');
// Temp folders of this file, removed after its tests.
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function project(grants) {
  const p = path.join(mkdtemp('gd-'), 'projects', 'demo');
  fs.mkdirSync(path.join(p, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(p, 'dispatch-rules.json'), JSON.stringify({
    heavy: [{ name: 'e2e', tools: '^Bash$', commands: 'jest' }],
    medium: [{ name: 'browser', tools: '^mcp__claude-in-chrome__' }],
  }));
  if (grants) fs.writeFileSync(path.join(p, 'memory', 'dispatch-grants.json'), JSON.stringify(grants));
  return p;
}
const ev = (p, tool, command) => ({ cwd: path.join(p, 'worktrees', 'K-1'), tool_name: tool, tool_input: { command } });

test('decide: outside worktrees and on light calls — allow', () => {
  const p = project();
  assert.strictEqual(decide({ cwd: path.join(p, 'repo'), tool_name: 'Bash', tool_input: { command: 'npx jest' } }), null);
  assert.strictEqual(decide(ev(p, 'Bash', 'git status')), null);
});

test('decide: heavy without a grant — blocked with a reason, journaled', () => {
  const p = project();
  const r = decide(ev(p, 'Bash', 'npx jest x'));
  assert.match(r.reason, /Заблокировано замком диспетчера: «e2e»/);
  assert.match(fs.readFileSync(path.join(p, 'memory', 'dispatch-guard.log'), 'utf8'), /"decision":"blocked"/);
});

test('decide: a valid grant passes; heavy covers medium; another holder or expiry blocks', () => {
  const soon = new Date(Date.now() + 600000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(decide(ev(project({ heavy: { holder: 'K-1', until: soon } }), 'Bash', 'npx jest')), null);
  assert.strictEqual(decide(ev(project({ heavy: { holder: 'K-1', until: soon } }), 'mcp__claude-in-chrome__navigate')), null);
  assert.ok(decide(ev(project({ heavy: { holder: 'K-2', until: soon } }), 'Bash', 'npx jest')));
  assert.ok(decide(ev(project({ heavy: { holder: 'K-1', until: past } }), 'Bash', 'npx jest')));
});

// ---- Замок по программе (срез 15): decide(ev, { by: 'program' }) судит по тому, что команда запустит.
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'guard.fixtures.json'), 'utf8'));
const ROOT = path.join(__dirname, '..', '..', '..', '..');
const SETS = {
  template: JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'project', 'dispatch-rules.example.json'), 'utf8')),
  polygon: JSON.parse(fs.readFileSync(path.join(ROOT, 'polygon', 'fixtures', 'dispatch-rules.json'), 'utf8')),
  'project-a': FIX['project-a'], 'project-b': FIX['project-b'], hub: FIX.hub,
};
function projectWith(rules, files = {}) {
  const p = path.join(mkdtemp('gp-'), 'projects', 'demo');
  fs.mkdirSync(path.join(p, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(p, 'dispatch-rules.json'), JSON.stringify(rules));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(p, 'worktrees', 'K-1', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return p;
}
const ruleOf = (r) => (r ? (r.reason.match(/«([^»]+)»/) || [])[1] : null);
const prog = (p, command, tool = 'Bash') => ruleOf(decide(ev(p, tool, command), { by: 'program' }));
const text = (p, command, tool = 'Bash') => ruleOf(decide(ev(p, tool, command)));

test('decide by program: обходы шаблона полигона ловятся, упоминание в тексте не блокирует', () => {
  const p = projectWith(SETS.polygon, { 'scripts/test-batch.sh': '#!/bin/sh\nnpx jest "$@"\n' });
  for (const cmd of ['npm --prefix apps/frontend run dev', 'npx --yes jest src/a.spec.ts', 'pnpm exec playwright test',
    'node node_modules/jest/bin/jest.js src/a.spec.ts', 'bash scripts/test-batch.sh', 'env CI=1 timeout 600 npx jest',
    'bash -c "npx playwright test"', 'X=jest; npx $X', 'yarn dev', 'pnpm --filter web run dev', 'npm start',
    '( cd apps/frontend && npx tsc --noEmit )', 'npx jest src/a.spec.ts', 'npm ci', 'npx prisma migrate deploy'])
    assert.ok(prog(p, cmd), `ждали блок: ${cmd}`);
  for (const cmd of ['grep -n "timeout 1200 npx jest --testPathIgnorePatterns" /tmp/s/batches.sh',
    'sed -n 1,40p memory/snippets/test-all-batches.sh; ls apps/backend/.env.test', 'node --check /tmp/s/memory/snippets/shots-login.cjs',
    'git add a.ts && git commit -m "fix: типы после kubb generate"', "cat >> memory/errors.md <<'EOF'\n- урок: npx playwright без гранта не запускать\nEOF",
    'echo "npm ci"', 'npx vitest run src/a.test.ts', 'git log --grep "npx jest"', 'cat scripts/test-batch.sh'])
    assert.strictEqual(prog(p, cmd), null, `ждали пропуск: ${cmd}`);
  // MCP-правила (tools/input) — как раньше
  assert.strictEqual(prog(p, undefined, 'mcp__Claude_Browser__preview_start'), null);
  assert.ok(ruleOf(decide({ ...ev(p, 'mcp__Claude_Browser__preview_start'), tool_input: { name: 'web' } }, { by: 'program' })));
});

test('decide by program: незнакомая обёртка или скрипт, которого нет, — суд по тексту, не пропуск (ревью р1)', () => {
  const p = projectWith(SETS.polygon);
  for (const cmd of ['xvfb-run npx playwright test', 'npx concurrently "npm run dev" "x"', 'screen -dmS t npx jest', 'tmux new -d "npx jest"',
    'su - me -c "npx jest"', 'runuser -u me -- npx jest', 'nodemon --exec "npx jest"', 'npx dotenv-cli -e .env -- npx jest',
    'script -qc "npx jest" /dev/null', 'pm2 start npx jest', 'prlimit --as=1 npx jest', 'chrt 0 npx jest', 'parallel ::: "npx jest"',
    "cat > /tmp/zz.sh <<'EOF'\nnpx jest src\nEOF\nbash /tmp/zz.sh", 'printf "npx jest\\n" > ./zz.sh && sh ./zz.sh'])
    assert.ok(prog(p, cmd), `ждали блок: ${cmd}`);
  // данные — по-прежнему не блок; файлы, известные при запуске, — не «полный прогон»; source — окружение
  for (const cmd of ['grep -rn "npx jest" .', 'git commit -m "npx jest"', 'echo npx jest', 'sed -n 1p test-all-batches.sh',
    'npx vitest run --project unit $(cat list.txt)', 'for f in a.test.ts b.test.ts; do npx vitest run $f; done'])
    assert.strictEqual(prog(p, cmd), null, cmd);
});

test('decide by program: source файла, запуск по пути, программы, исполняющие аргументы (ревью р2)', () => {
  const p = projectWith(SETS.polygon, { 'run-tests.sh': '#!/bin/sh\nnpx jest src\n', 'lib.sh': 'export L=1\nt() { npx jest; }\n',
    'noshebang': 'npx jest\n' });
  fs.chmodSync(path.join(p, 'worktrees', 'K-1', 'noshebang'), 0o755);
  for (const cmd of ['. ./run-tests.sh', 'source ./run-tests.sh', '. ./lib.sh; t',
    "printf '#!/bin/sh\\nnpx jest\\n' > z.sh && chmod +x z.sh && ./z.sh", './noshebang',
    'git bisect run npx jest', 'git rebase -x "npx jest" HEAD~3', 'git submodule foreach "npx jest"',
    "git -c alias.t='!npx jest' t", 'trap "npx jest" EXIT; true', "sed -n '1e npx jest' a.txt", 'sqlite3 :memory: ".shell npx jest"',
    'tar --to-command="npx jest" -xf a.tar', "rg --pre 'npx jest' x .", "node polygon/run.cjs --only 'M01|M02' --model opus"])
    assert.ok(prog(p, cmd), `ждали блок: ${cmd}`);
  assert.ok(prog(p, "sed 's/x/npx jest/e' a.txt"), 's///e');
  assert.ok(prog(p, "sed --expression='1e npx jest' a.txt"), 'sed --expression= (ревью р3)');
  assert.ok(prog(p, "sed -n --expression '1e npx jest' a.txt"), 'sed --expression <скрипт>');
  for (const cmd of ['. ./lib.sh; echo $L', 'git log --oneline -3', "sed -n '1,5p' a.txt", "sed -i 's/npx jest/x/' a.txt", 'tar -xf a.tar',
    "sed -i 's#node a/snippets/x.cjs#node /home/george/b/snippets/x.cjs#; s#--a#--b#' c.json"])
    assert.strictEqual(prog(p, cmd), null, cmd);
});

test('decide by program: функции-обёртки с "$@", cd и source в теле, тело без скобок (ревью р3)', () => {
  const p = projectWith(SETS.polygon, { 'lib2.sh': 'retry() { "$@"; }\n', 'lib3.sh': 'with_db() { export DB=x; "$@"; }\n',
    'sub/x.sh': '#!/bin/sh\nnpx jest\n', 'rt.sh': 'npx jest src\n', 'lib.sh': 'export L=1\nt() { npx jest; }\n' });
  for (const cmd of ['retry() { for i in 1 2 3; do "$@" && break; done; }; retry npx jest src', 'run() { echo "+ $*"; "$@"; }; run npx jest',
    'retry() { local n=0; until "$@"; do n=$((n+1)); done; }; retry npx jest', '. ./lib3.sh && with_db npx jest', '. ./lib2.sh; retry npx jest',
    't() { npx "$1"; }; t jest', 'f() { cd sub; ./x.sh; }; f', 'f() { . ./rt.sh; }; f', 'f() { source ./lib.sh; t; }; f',
    'f() if true; then :; fi; { npx jest; } > log', 'f() for i in 1; do :; done; { npx jest; }'])
    assert.ok(prog(p, cmd), `ждали блок: ${cmd}`);
});

test('decide by program: yarn|pnpm <бинарь> — бинарь; yarn --version — не установка (ревью р1)', () => {
  const a = projectWith(SETS['project-a']);
  assert.strictEqual(prog(a, 'yarn next dev'), 'дев-серверы');
  assert.strictEqual(prog(a, 'pnpm next dev'), 'дев-серверы');
  assert.strictEqual(prog(a, 'yarn kubb generate'), 'kubb');
  assert.strictEqual(prog(a, 'pnpm vitest run'), 'полный vitest');
  const p = projectWith(SETS.polygon);
  for (const cmd of ['yarn --version', 'yarn -v', 'yarn --help']) assert.strictEqual(prog(p, cmd), null, cmd);
  assert.ok(prog(p, 'yarn'), 'голый yarn — установка');
});

test('decide: по умолчанию (стадия off нового модуля) — прежнее решение по тексту', () => {
  const p = projectWith(SETS.polygon);
  assert.strictEqual(text(p, 'grep -n "npx jest" a.sh'), 'тесты с общей базой', 'текстовый замок ловит упоминание, как в v1');
  assert.strictEqual(text(p, 'npx --yes jest'), null, 'и пропускает обход, как в v1');
});

test('decide by program: не разобрал или программа неизвестна — судит по тексту всей команды', () => {
  const p = projectWith(SETS.polygon);
  assert.strictEqual(prog(p, 'echo "npx jest'), 'тесты с общей базой');
  assert.strictEqual(prog(p, 'echo npx jest | bash'), 'тесты с общей базой');
  assert.strictEqual(prog(p, '$RUN npx jest'), 'тесты с общей базой');
  const r = decide(ev(p, 'Bash', 'eval "$C"; npx jest'), { by: 'program' });
  assert.match(r.reason, /Программа: npx jest/);
});

test('decide by program: мок модели (ANTHROPIC_BASE_URL на 127.0.0.1/localhost) — лёгкое, в любой записи', () => {
  const p = projectWith(SETS.hub);
  assert.ok(prog(p, 'claude -p hi'));
  assert.ok(prog(p, 'cd /x && claude --print hi'));
  for (const cmd of ['ANTHROPIC_BASE_URL=http://127.0.0.1:9 claude -p hi', 'env ANTHROPIC_BASE_URL=http://localhost:9 claude -p hi',
    'export ANTHROPIC_BASE_URL=http://127.0.0.1:9; claude -p hi', 'grep -n "claude -p" a.md', 'git commit -m "claude -p и мок"'])
    assert.strictEqual(prog(p, cmd), null, cmd);
});

// Старые правила проектов — без правки: каждое ловит свою форму запуска и по программе, и по тексту (как в v1);
// упоминания — пропуск по программе.
const EXAMPLES = {
  template: {
    block: [['npm run dev', 'дев-серверы'], ['npx jest a', 'тесты с общей базой'], ['npx prisma db push', 'миграции и общая БД'],
      ['psql -c "select 1"', 'миграции и общая БД'], ['npm i', 'установка зависимостей'], ['npx tsc --noEmit', 'полная сборка'],
      ['npm run build', 'полная сборка'], ['npx vitest run', 'полный vitest']],
    allow: ['grep -rn "npx jest" apps', 'npx vitest run src/a.test.ts', 'echo psql'],
  },
  polygon: {
    block: [['npx playwright test', 'playwright и пробы'], ['node memory/snippets/shots-login.cjs', 'playwright и пробы'],
      ['bash memory/snippets/test-all-batches.sh', 'тесты с общей базой'], ['claude -p hi', 'модельные прогоны полигона'],
      ['node polygon/run.cjs --model m --only M01', 'модельные прогоны полигона'], ['npx kubb generate', 'kubb']],
    allow: ['cat memory/snippets/test-all-batches.sh', 'git commit -m "kubb generate"'],
  },
  'project-a': {
    block: [['npm run dev', 'дев-серверы'], ['npx playwright test', 'playwright и пробы'], ['npx jest a', 'jest бэка и тестовая БД'],
      ['npm run test:e2e', 'jest бэка и тестовая БД'], ['bash memory/snippets/backend-all-batches.sh', 'jest бэка и тестовая БД'],
      ['npx prisma migrate deploy', 'дев-БД и миграции'], ['docker compose up -d', 'дев-БД и миграции'],
      ['bash ~/hub/plugin/skills/dispatch/scripts/hub-run.sh T-1-x -MemoryMax 4G -- npm test', 'прогон hub-run с потолком от 4G (jest, стенд в скрипте)'],
      ['npm ci', 'npm ci'], ['npx tsc --noEmit', 'tsc'], ['npx vitest run', 'полный vitest'], ['npx kubb generate', 'kubb'],
      ['bash ~/hub/plugin/skills/dispatch/scripts/hub-run.sh T-1-x -- npm run lint', 'любой прогон hub-run (команда в скрипте)']],
    allow: ['grep -rn "npx jest" apps', 'git commit -m "kubb generate"', 'bash ~/hub/plugin/skills/dispatch/scripts/hub-run.sh --list',
      'cat memory/snippets/backend-all-batches.sh'],
  },
  'project-b': {
    block: [['npm run dev', 'дев-серверы'], ['FOO=1 npm run preview', 'дев-серверы'], ['npx nuxt dev', 'дев-серверы'],
      ['docker compose up -d', 'Docker-стенд'], ['npx playwright test', 'playwright'], ['node memory/snippets/shots-home.cjs', 'playwright'],
      ['npm ci', 'установка зависимостей'], ['composer install', 'установка зависимостей'], ['npm run build', 'полная сборка'],
      ['npx nuxt generate', 'полная сборка'], ['docker compose run app php artisan test', 'полный прогон PHP'], ['php artisan test', 'полный прогон PHP']],
    allow: ['echo "npm run dev"', 'php artisan test --filter X', 'grep "npx playwright" -r .'],
  },
  hub: {
    block: [['claude -p hi', null], ['node polygon/run.cjs --level model --only M01', 'модельные сценарии полигона'],
      ['node polygon/run.cjs --only H02', 'полигон без --level hook (по умолчанию гоняет и модельные сценарии; compare/regrade — лёгкое)'],
      ['npx --yes jest', 'тесты и общая БД проекта A'], ['createdb x', 'тесты и общая БД проекта A'], ['npm i', 'установка зависимостей'],
      ['python3 tools/hub-data/snapshot.py ~/hub-data', 'снимок данных хаба (диск)']],
    allow: ['node polygon/run.cjs --level hook --only H02', 'node polygon/run.cjs compare a.json b.json',
      'python3 tools/hub-data/snapshot.py --verify ~/hub-data', 'grep -rn "createdb" docs'],
  },
};

test('старые dispatch-rules.json проектов (синтетические копии) разбираются без правки', () => {
  for (const [set, { block, allow }] of Object.entries(EXAMPLES)) {
    const p = projectWith(SETS[set]);
    for (const [cmd, rule] of block) {
      const want = rule || SETS[set].heavy[0].name;
      assert.strictEqual(prog(p, cmd), want, `${set}: по программе «${cmd}»`);
      assert.strictEqual(text(p, cmd), want, `${set}: по тексту «${cmd}» — как в v1`);
    }
    for (const cmd of allow) assert.strictEqual(prog(p, cmd), null, `${set}: пропуск «${cmd}»`);
  }
});

test('decide by program: журнал помечает способ решения', () => {
  const p = projectWith(SETS.polygon);
  decide(ev(p, 'Bash', 'npx --yes jest'), { by: 'program' });
  const line = JSON.parse(fs.readFileSync(path.join(p, 'memory', 'dispatch-guard.log'), 'utf8').trim().split('\n').pop());
  assert.strictEqual(line.by, 'program');
  assert.strictEqual(line.decision, 'blocked');
});

// Модули: 11-lock-program — новый замок за своей стадией; 10-lock уступает ему, когда он включён в проекте.
const HOOKS = path.join(__dirname, '..', '..', '..', 'hooks');
test('модули замка: стадия lock-program решает, кто судит — программа или текст', () => {
  const lock = require(path.join(HOOKS, 'pretool.d', '10-lock.cjs'));
  const lockProgram = require(path.join(HOOKS, 'pretool.d', '11-lock-program.cjs'));
  const { programLockActive } = require('./guard.cjs');
  const p = projectWith(SETS.polygon);
  const plugin = mkdtemp('gplug-');
  fs.mkdirSync(path.join(plugin, 'mechanisms'));
  fs.mkdirSync(path.join(plugin, 'hooks', 'pretool.d'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'hooks', 'pretool.d', '11-lock-program.cjs'), '');
  const stage = (s) => fs.writeFileSync(path.join(plugin, 'mechanisms', 'lock-program.json'), JSON.stringify({ id: 'lock-program', file: 'pretool.d/11-lock-program.cjs', stage: s }));
  const project = { dir: p, name: 'demo' };
  stage('off');
  assert.strictEqual(programLockActive(plugin, project), false);
  stage('canary');
  assert.strictEqual(programLockActive(plugin, project), false, 'канарейка без canary.json проекта');
  fs.writeFileSync(path.join(p, 'canary.json'), JSON.stringify({ mechanisms: ['lock-program'] }));
  assert.strictEqual(programLockActive(plugin, project), true);
  stage('on');
  fs.rmSync(path.join(p, 'canary.json'));
  assert.strictEqual(programLockActive(plugin, project), true);
  assert.strictEqual(programLockActive(plugin, null), true, 'стадия on — и без проекта');
  fs.rmSync(path.join(plugin, 'hooks', 'pretool.d', '11-lock-program.cjs'));
  assert.strictEqual(programLockActive(plugin, project), false, 'нет файла модуля — раннеру нечего запускать');

  // Реальная запись реестра: новый модуль — канарейка; 10-lock судит по тексту там, где он не включён.
  const rec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'mechanisms', 'lock-program.json'), 'utf8'));
  assert.deepStrictEqual([rec.stage, rec.handler, rec.file, rec.onError], ['canary', 'lock', 'pretool.d/11-lock-program.cjs', 'closed']);
  const e = ev(p, 'Bash', 'grep -n "npx jest" a.sh');
  assert.strictEqual(lock.run(e, { project }).decision, 'block', 'без канарейки — прежний замок по тексту');
  assert.strictEqual(lockProgram.run(e, { project }), null);
  assert.strictEqual(lockProgram.run(ev(p, 'Bash', 'npx --yes jest'), { project }).decision, 'block');
  fs.writeFileSync(path.join(p, 'canary.json'), JSON.stringify({ mechanisms: ['lock-program'] }));
  assert.strictEqual(lock.run(e, { project }), null, 'lock-program включён в проекте — текстовый замок молчит');
});
