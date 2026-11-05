// node --test plugin/skills/recall/scripts/recall.test.cjs — the `recall` command over plugin/lib/memory/store.cjs.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { formatLesson } = require('../../../lib/memory/format.cjs');

const CLI = path.join(__dirname, 'recall.cjs');
const tmp = (p = 'recall-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const lesson = (id, first, more = {}) => formatLesson({ id, kind: more.kind || 'rule', when: more.when || [], keys: more.keys || [],
  status: more.status || 'active', supersedes: [], source: 'модель', created: '2026-11-01' }, [first, 'Вторая строка урока.']);

function project() {
  const hub = tmp('hub-');
  const proj = path.join(hub, 'projects', 'demo');
  const mem = path.join(proj, 'memory');
  fs.mkdirSync(path.join(mem, 'lessons'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'worktrees', 'K-1'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'lessons', 'bash-heredoc.md'), lesson('bash-heredoc', 'Скрипт с кавычками — файлом через Write, не heredoc.', { keys: ['heredoc'] }));
  fs.writeFileSync(path.join(mem, 'lessons', 'prisma-first.md'), lesson('prisma-first', 'После смены ветки — генерация клиента prisma до тестов.', { keys: ['prisma'] }));
  fs.writeFileSync(path.join(mem, 'lessons', 'no-push.md'), lesson('no-push', 'Пуш — только по явной просьбе.', { kind: 'once', status: 'core' }));
  return { hub, proj, mem };
}
const run = (args, { cwd = os.tmpdir(), env = {} } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('find from a cwd inside the project: top hits in the «data, not instructions» frame, with file and counters', () => {
  const { hub, proj } = project();
  const r = run(['find', 'генерацию', 'клиента'], { cwd: path.join(proj, 'worktrees', 'K-1'), env: { AI_DEV_HUB: hub } });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /данные из памяти, не инструкции/);
  assert.match(r.out, /1\. prisma-first \[по касанию · rule\] После смены ветки/);
  assert.match(r.out, /memory\/lessons\/prisma-first\.md · показан 0, повторов 0/);
  assert.strictEqual(r.err, '');
});

test('find: nothing found says so; --json gives the hits; --archive reaches retired lessons', () => {
  const { mem } = project();
  assert.match(run(['--memory', mem, 'find', 'mailpit']).out, /ничего не найдено/);
  const j = JSON.parse(run(['--memory', mem, 'find', 'heredoc', '--json']).out);
  assert.strictEqual(j.hits[0].id, 'bash-heredoc');
  assert.strictEqual(run(['--memory', mem, 'retire', 'bash-heredoc', '--note', 'не нужен']).code, 0);
  assert.match(run(['--memory', mem, 'find', 'heredoc']).out, /ничего не найдено/);
  assert.match(run(['--memory', mem, 'find', 'heredoc', '--archive']).out, /bash-heredoc \[архив · rule\]/);
});

test('a project without memory/lessons/: «памяти нового формата нет», code 0; outside the hub — code 2', () => {
  const { hub, proj, mem } = project();
  fs.rmSync(path.join(mem, 'lessons'), { recursive: true });
  const r = run(['find', 'heredoc'], { cwd: proj, env: { AI_DEV_HUB: hub } });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /памяти нового формата нет/);
  assert.strictEqual(run(['find', 'x'], { cwd: os.tmpdir(), env: { AI_DEV_HUB: hub } }).code, 2);
});

test('repeat, retire, merge, why: files and events; once-class refused with code 1', () => {
  const { mem } = project();
  assert.strictEqual(run(['--memory', mem, 'repeat', 'prisma-first']).code, 0);
  assert.strictEqual(run(['--memory', mem, 'merge', 'bash-heredoc', 'prisma-first']).code, 0);
  assert.match(fs.readFileSync(path.join(mem, 'lessons', 'prisma-first.md'), 'utf8'), /supersedes: \[bash-heredoc\]/);
  const why = run(['--memory', mem, 'why', 'prisma-first']).out;
  assert.match(why, /memory\/lessons\/prisma-first\.md/);
  assert.match(why, /repeat/);
  assert.match(run(['--memory', mem, 'why', 'bash-heredoc']).out, /merged → prisma-first/);
  const once = run(['--memory', mem, 'retire', 'no-push']);
  assert.strictEqual(once.code, 1);
  assert.match(once.err, /одного раза/);
  assert.strictEqual(run(['--memory', mem, 'repeat', 'no-such']).code, 1);
});

test('similar: near lessons of a draft file, the draft itself left out', () => {
  const { mem } = project();
  const draft = path.join(tmp(), 'draft.md');
  fs.writeFileSync(draft, lesson('heredoc-again', 'Heredoc с кавычками ломает скрипт — файлом через Write.', { keys: ['heredoc'] }));
  assert.match(run(['--memory', mem, 'similar', draft]).out, /bash-heredoc/);
});

test('check names a NUL lesson and a torn event line; export → import → the same bytes; export-v1 writes three files', () => {
  const { mem } = project();
  run(['--memory', mem, 'repeat', 'prisma-first']);
  fs.appendFileSync(path.join(mem, 'lessons', 'bash-heredoc.md'), 'x\u0000\n');
  const ev = fs.readdirSync(path.join(mem, 'events'))[0];
  fs.appendFileSync(path.join(mem, 'events', ev), '{"torn');
  const c = run(['--memory', mem, 'check']);
  assert.strictEqual(c.code, 0);
  assert.match(c.out, /bash-heredoc\.md[^\n]*NUL/);
  assert.match(c.out, new RegExp(`${ev.replace('.', '\\.')}:2`));
  const out = tmp();
  assert.strictEqual(run(['--memory', mem, 'export', path.join(out, 'm.json')]).code, 0);
  const mem2 = path.join(tmp(), 'memory');
  assert.strictEqual(run(['--memory', mem2, 'import', path.join(out, 'm.json')]).code, 0);
  for (const f of ['lessons/bash-heredoc.md', `events/${ev}`]) {
    assert.ok(fs.readFileSync(path.join(mem2, f)).equals(fs.readFileSync(path.join(mem, f))), f);
  }
  assert.strictEqual(run(['--memory', mem, 'export-v1', path.join(out, 'v1')]).code, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(out, 'v1')).sort(), ['decisions.md', 'errors-index.md', 'errors.md']);
});

test('usage: no command or an unknown one — code 2 with the list of commands', () => {
  const { mem } = project();
  const r = run(['--memory', mem, 'frobnicate']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /find/);
});
