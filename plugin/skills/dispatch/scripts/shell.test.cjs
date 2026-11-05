// node --test shell.test.cjs — разбор shell: какие программы реально запустит команда (замок 15, полигон, аналитика).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executions } = require('./shell.cjs');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// Every program the command runs, as «argv joined by spaces» (bin: a package binary, marked «bin:»).
const progs = (cmd, opts) => executions(cmd, opts).execs.map((e) => (e.bin ? 'bin:' : '') + e.argv.join(' '));
const has = (cmd, want, opts) => assert.ok(progs(cmd, opts).includes(want), `${JSON.stringify(cmd)} → ${JSON.stringify(progs(cmd, opts))}, ждали «${want}»`);
const runsNo = (cmd, prog, opts) => {
  const p = progs(cmd, opts);
  assert.ok(!p.some((x) => x.replace(/^bin:/, '').split(' ')[0] === prog), `${JSON.stringify(cmd)} → ${JSON.stringify(p)}: «${prog}» не запускается`);
};

test('executions: списки, конвейеры, подоболочки, подстановки — каждая простая команда', () => {
  const cmd = 'git status; ls -la && ( cd apps && npx tsc --noEmit ) | tee o || echo $(npx jest a) `date -u`';
  for (const want of ['git status', 'ls -la', 'cd apps', 'npx tsc --noEmit', 'bin:tsc --noEmit', 'tee o', 'npx jest a', 'bin:jest a', 'date -u'])
    has(cmd, want);
  has('cat <(npx jest) >(wc -l)', 'bin:jest');
  has('if true; then npx jest; elif false; then :; else echo; fi', 'bin:jest');
  has('while read f; do npx jest; done < list', 'bin:jest');
  has('{ npx jest; } 2>&1', 'bin:jest');
  has('f() { npx jest; }; f', 'bin:jest');
  has('time npx jest', 'bin:jest');
  has('! npx jest', 'bin:jest');
});

test('executions: текст — не программа: кавычки, heredoc, комментарии, case, for, [[ ]]', () => {
  runsNo('grep -n "timeout 1200 npx jest --x" /tmp/s/batches.sh', 'npx');
  runsNo('git commit -m "fix: типы после kubb generate"', 'kubb');
  runsNo("cat >> memory/errors.md <<'EOF'\n- урок: npx playwright без гранта не запускать\nEOF", 'npx');
  runsNo('cat <<EOF > a\nnpx jest\nEOF\nls', 'npx');
  runsNo('echo hi # npx jest', 'npx');
  runsNo("echo 'npx jest' \"npm ci\"", 'npm');
  runsNo('for f in npx jest; do echo "$f"; done', 'jest');
  runsNo('case "$x" in jest) echo a ;; npx|tsc) echo b ;; esac', 'jest');
  runsNo('[[ "$a" == "npx jest" && -n $b ]] && echo ok', 'npx');
  runsNo('x=$(( 1 + 2 )); echo $x', 'npx');
  // после heredoc и case разбор идёт дальше
  has("cat > a <<EOF\ntext\nEOF\nnpx jest", 'bin:jest');
  has('case a in a) npx jest ;; esac', 'bin:jest');
});

test('executions: обёртки — env, timeout, nice, nohup, sudo, xargs, find -exec, watch, dotenv, cross-env, hub-run', () => {
  has('env -u X FOO=1 npx jest', 'bin:jest');
  has('timeout -k 5 1200 npx jest a', 'bin:jest a');
  has('nice -n 10 nohup npx playwright test &', 'bin:playwright test');
  has('sudo -u pg psql -c "select 1"', 'psql -c select 1');
  has('ls *.spec.ts | xargs -n 1 npx jest', 'bin:jest');
  has('find . -name "*.ts" -exec npx tsc {} \\;', 'bin:tsc {}');
  has('watch -n 5 npx jest', 'bin:jest');
  has('dotenv -e .env.test -- npx prisma migrate deploy', 'bin:prisma migrate deploy');
  has('npx cross-env NODE_ENV=test jest a', 'bin:jest a');
  has('bash ~/hub/plugin/skills/dispatch/scripts/hub-run.sh T-1-jest -MemoryMax 4G -- npx jest', 'bin:jest');
  has('command -p npx jest', 'bin:jest');
  has('docker exec -it -e PGUSER=x pg_container psql -U admin -c "select 1"', 'psql -U admin -c select 1');
  has("docker exec pg sh -c 'psql -l'", 'psql -l');
  has('docker run --rm -v a:/b -w /b img php artisan test', 'php artisan test');
  has('docker compose -f d.yml exec -T api npx prisma migrate deploy', 'bin:prisma migrate deploy');
  runsNo('docker ps --format "{{.Names}} psql"', 'psql');
  has('exec npx jest', 'bin:jest');
  // env передаёт присваивания программе
  const e = executions('env ANTHROPIC_BASE_URL=http://127.0.0.1:9 claude -p hi').execs.find((x) => x.argv[0] === 'claude');
  assert.strictEqual(e.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
});

test('executions: пакетные раннеры — npx с ключами, pnpm/yarn/bun, npm exec, node по пути в node_modules', () => {
  has('npx --yes jest src/a.spec.ts', 'bin:jest src/a.spec.ts');
  has('npx -y -p jest@29 jest a', 'bin:jest a');
  has('npx --prefix apps/backend dotenv -e apps/backend/.env -- node probe.cjs', 'bin:node probe.cjs');
  has('npx jest@29.7.0 a', 'bin:jest a');
  has('pnpm exec playwright test', 'bin:playwright test');
  has('pnpm dlx prisma migrate dev', 'bin:prisma migrate dev');
  has('yarn dlx playwright test', 'bin:playwright test');
  has('bunx playwright test', 'bin:playwright test');
  has('npm exec -- jest a', 'bin:jest a');
  has('npm x jest a', 'bin:jest a');
  has('node node_modules/jest/bin/jest.js src/a.spec.ts', 'bin:jest src/a.spec.ts');
  has('node --max-old-space-size=4096 ./node_modules/.bin/jest a', 'bin:jest a');
  has('./node_modules/.bin/playwright test', 'bin:playwright test');
  has('node_modules/typescript/bin/tsc --noEmit', 'bin:tsc --noEmit');
  has('npx -c "jest a"', 'bin:jest a');
  runsNo('node --check memory/snippets/shots-login.cjs', 'shots-login');
  runsNo('node -e "require(\'child_process\').execSync(\'npx jest\')"', 'npx');
});

test('executions: строки как код — bash -c, sh -c, eval, bash со stdin из heredoc', () => {
  has('bash -c "npx jest a"', 'bin:jest a');
  has("sh -lc 'cd x && npx tsc'", 'bin:tsc');
  has('eval "npx" jest', 'bin:jest');
  has("bash -s <<'EOF'\nnpx jest\nEOF", 'bin:jest');
  has('flock /tmp/l -c "npx jest"', 'bin:jest');
});

test('executions: переменные — известные подставляются, без кавычек делятся на слова; неизвестная программа — unknown', () => {
  has('X=jest; npx $X a', 'bin:jest a');
  has('R="npx jest"; $R a', 'bin:jest a');
  has('export T=playwright\nnpx "${T}" test', 'bin:playwright test');
  has('P=npx; $P --yes jest', 'bin:jest');
  // присваивание перед командой — окружение этой команды
  const e = executions('ANTHROPIC_BASE_URL=http://localhost:1 claude -p x').execs.find((x) => x.argv[0] === 'claude');
  assert.strictEqual(e.env.ANTHROPIC_BASE_URL, 'http://localhost:1');
  const two = executions("A=1 B='x y' LABEL=after timeout 500 node probe.cjs").execs;
  assert.deepStrictEqual(two[0].argv, ['timeout', '500', 'node', 'probe.cjs']);
  assert.deepStrictEqual(two[0].env, { A: '1', B: 'x y', LABEL: 'after' });
  const ex = executions('export ANTHROPIC_BASE_URL=http://127.0.0.1:2; claude --print x').execs.find((x) => x.argv[0] === 'claude');
  assert.strictEqual(ex.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:2');
  // программа неизвестна до запуска — честно «не знаю»
  assert.ok(executions('$RUNNER jest').unknown.length > 0);
  assert.ok(executions('eval "$CMD"').unknown.length > 0);
  assert.ok(executions('echo npx jest | bash').unknown.length > 0);
  assert.strictEqual(executions('npx jest "$@"').unknown.length, 0, 'неизвестные аргументы — не неизвестная программа');
});

test('executions: скрипт читается и разбирается — bash file, ./file, source; $@ — аргументы вызова; cd учитывается', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, 'scripts', 'batch.sh'), '#!/bin/sh\nset -e\nnpx jest "$@"\n');
  fs.writeFileSync(path.join(d, 'scripts', 'outer.sh'), '#!/usr/bin/env bash\nbash scripts/batch.sh a\n"$@"\n');
  fs.writeFileSync(path.join(d, 'scripts', 'node-cli'), '#!/usr/bin/env node\nconsole.log(1)\n');
  fs.writeFileSync(path.join(d, 'scripts', 'env.sh'), 'export RUN=playwright\n');
  const o = { cwd: d };
  has('bash scripts/batch.sh src/a.spec.ts', 'bin:jest src/a.spec.ts', o);
  has('./scripts/batch.sh', 'bin:jest', o);
  has('sh -e scripts/batch.sh', 'bin:jest', o);
  has('cd scripts && bash batch.sh', 'bin:jest', o);
  has('( cd scripts; ./batch.sh x )', 'bin:jest x', o);
  has('bash scripts/outer.sh npx playwright test', 'bin:playwright test', o);
  has('source scripts/env.sh; npx $RUN test', 'bin:playwright test', o);
  has('. scripts/env.sh && npx $RUN test', 'bin:playwright test', o);
  // тело функции считается запущенным при определении (решение 05.11 после ревью р3: ошибка в сторону блока).
  // Известный остаток: неиспользованная функция source-библиотеки тоже «запускается» — ложный блок, не пропуск.
  fs.writeFileSync(path.join(d, 'lib.sh'), 'export L=1\ninst() { npm install -g x; }\nfunction other { npx jest; }\n');
  has('. ./lib.sh; echo $L', 'npm install -g x', o);
  has('. ./lib.sh; inst', 'npm install -g x', o);
  has('. ./lib.sh; other', 'bin:jest', o);
  has('f() { npx jest; }; echo', 'bin:jest');
  has('f() { npx jest; }; f', 'bin:jest');
  // вызов функции — незнакомая программа: его строку замок судит как текст
  assert.ok(executions('retry() { "$@"; }; retry npx jest').execs.some((e) => e.argv[0] === 'retry' && e.opaque));
  has('g() { npx jest; }; h() { g; }; h', 'bin:jest');
  runsNo('r() { r; }; r', 'npx'); // рекурсия не вешает
  assert.strictEqual(executions('source scripts/env.sh', o).unknown.length, 0);
  // скрипт — тоже программа (правила называют скрипты по имени)
  has('bash scripts/batch.sh', 'scripts/batch.sh', o);
  runsNo('cat scripts/batch.sh; sed -n 1p scripts/batch.sh', 'npx', o);
  runsNo('bash -n scripts/batch.sh && echo ok', 'npx', o);
  runsNo('./scripts/node-cli', 'console.log(1)', o);
  // нет файла — сам вызов остаётся программой, без содержимого
  has('bash scripts/missing.sh', 'scripts/missing.sh', o);
  // рекурсия ограничена: скрипт, зовущий сам себя, не вешает разбор
  fs.writeFileSync(path.join(d, 'loop.sh'), 'bash loop.sh\nnpx jest\n');
  has('bash loop.sh', 'bin:jest', o);
});

test('executions: подстановки в heredoc без кавычек, ${:-…}, $(( )), массивах; case с «(»', () => {
  has('cat <<EOF\n$(npx jest)\nEOF', 'bin:jest');
  has('cat <<EOF\n`npx tsc`\nEOF', 'bin:tsc');
  runsNo("cat <<'EOF'\n$(npx jest)\nEOF", 'npx');
  has('echo ${X:-$(npx jest)}', 'bin:jest');
  has('echo $(( $(npx jest | wc -l) ))', 'bin:jest');
  has('A=($(npx jest)); echo ok', 'bin:jest');
  has('case x in (a) npx jest;; esac', 'bin:jest');
});

test('executions: не знаю — unknown, а не тишина: скрипт не прочитан, лимиты, source <( )', () => {
  const d = tmp();
  assert.ok(executions('bash scripts/missing.sh', { cwd: d }).unknown.length > 0, 'скрипта нет на диске');
  assert.ok(executions('source <(echo "npx jest")').unknown.length > 0);
  let deep = 'npx jest';
  for (let k = 0; k < 4; k++) deep = `bash -c ${JSON.stringify(deep)}`;
  assert.ok(executions(deep).unknown.length > 0, 'глубина больше лимита');
  assert.ok(executions('true; '.repeat(401) + 'npx jest').unknown.length > 0, 'программ больше лимита');
  // hub-run.sh — известная обёртка: тело не читается, и это не «не знаю»
  assert.strictEqual(executions('bash ~/hub/plugin/skills/dispatch/scripts/hub-run.sh T-1 -- npx jest').unknown.length, 0);
});

test('executions: незнакомая программа помечена opaque, данные (grep, git, echo) — нет', () => {
  const op = (cmd) => executions(cmd).execs.map((e) => `${e.argv[0]}:${Boolean(e.opaque)}`);
  // незнакомая обёртка не раскрывается: её строку замок судит по тексту целиком
  assert.deepStrictEqual(op('xvfb-run npx playwright test'), ['xvfb-run:true']);
  assert.deepStrictEqual(op('npx playwright test'), ['npx:false', 'playwright:true']);
  assert.deepStrictEqual(op('node scripts/x.cjs "npx jest"'), ['node:false', 'scripts/x.cjs:false'], 'аргументы скрипта node — данные');
  assert.deepStrictEqual(op('grep -n x a; git commit -m y; echo z'), ['grep:false', 'git:false', 'echo:false']);
});

test('executions: не виснет — FIFO вместо скрипта, самоподключение source', () => {
  const d = tmp();
  require('child_process').execFileSync('mkfifo', [path.join(d, 'p')]);
  let t0 = Date.now();
  executions('./p', { cwd: d });
  assert.ok(Date.now() - t0 < 2000, 'FIFO не открывается');
  for (const n of [200, 3000, 28000]) {
    fs.writeFileSync(path.join(d, 'x.sh'), '. ./x.sh\n'.repeat(n));
    t0 = Date.now();
    const r = executions('. ./x.sh', { cwd: d });
    assert.ok(Date.now() - t0 < 2000, `self-source ×${n}: ${Date.now() - t0} мс`);
    assert.ok(r.unknown.length > 0 && r.unknown.length < 20, `упор в лимит — не знаю, без тысяч записей (${r.unknown.length})`);
  }
  // путь, которого нет, — не знаю (скрипт пишется в той же команде)
  assert.ok(executions('./z.sh', { cwd: d }).unknown.length > 0);
});

test('executions: незакрытая кавычка — error, без исключения', () => {
  const r = executions('echo "npx jest');
  assert.ok(r.error);
});

test('polygon/lib/shell.cjs — тот же разбор, публичный bareCd на месте', () => {
  const lib = require('../../../../polygon/lib/shell.cjs');
  assert.strictEqual(typeof lib.bareCd, 'function');
  assert.strictEqual(lib.executions, executions);
});
