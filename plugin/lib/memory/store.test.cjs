// node --test plugin/lib/memory/store.test.cjs — the storage interface: add, repeat, shown, find, export, import;
// the derived index (FTS5 or JS) and .triggers.json rebuilt by signature; status operations; v1 export.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./store.cjs');
const { formatLesson } = require('./format.cjs');

const tmp = (p = 'mem-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const lesson = (id, first, more = {}) => formatLesson({
  id, kind: more.kind || 'rule', when: more.when || [], keys: more.keys || [], status: more.status || 'active',
  supersedes: more.supersedes || [], source: more.source || 'модель', created: more.created || '2026-11-01',
}, [first, more.second || 'Вторая строка урока.']);

function memory(lessons = []) {
  const d = path.join(tmp(), 'memory');
  fs.mkdirSync(path.join(d, 'lessons'), { recursive: true });
  fs.mkdirSync(path.join(d, 'decisions'), { recursive: true });
  for (const [id, first, more] of lessons) {
    const dir = more && more.kind === 'decision' ? 'decisions' : 'lessons';
    fs.writeFileSync(path.join(d, dir, `${id}.md`), lesson(id, first, more));
  }
  return d;
}

const SET = [
  ['bash-heredoc', 'Скрипт с кавычками — файлом через Write, не heredoc и не node -e.', { keys: ['heredoc', 'node -e'],
    when: [{ tool: '^Bash$', cmd: "<<\\s*'?EOF" }] }],
  ['prisma-before-tests', 'После переключения ветки сначала генерация клиента prisma, потом юнит-тесты.', { keys: ['prisma'] }],
  ['cd-subshell', 'Переход в папку — только в подоболочке, рабочая папка общая для вызовов.', { keys: ['cd'], status: 'core',
    when: [{ tool: '^Bash$', cmd: '^cd\\s' }] }],
  ['no-push-once', 'Пуш — только по явной просьбе пользователя, каждый раз.', { kind: 'once', keys: ['пуш'] }],
  ['old-ports', 'Старый урок про порты дев-сервера, уже не действует.', { status: 'retired', keys: ['порт'] }],
  ['why-local-plan', 'План перестройки лежит локально, вне git хаба: хаб публичный.', { kind: 'decision', keys: ['план'] }],
];

test('find: top-1..3 by words with Russian endings; archive hidden unless asked; decisions found too', () => {
  const d = memory(SET);
  const r = S.find(d, 'генерацию клиента призмы перед тестами');
  assert.strictEqual(r.hits[0].id, 'prisma-before-tests');
  assert.ok(r.hits.length <= 3);
  assert.deepStrictEqual(S.find(d, 'порты дев-сервера').hits.map((h) => h.id), []);
  assert.deepStrictEqual(S.find(d, 'порты дев-сервера', { archive: true }).hits.map((h) => h.id), ['old-ports']);
  const why = S.find(d, 'почему план локально');
  assert.strictEqual(why.hits[0].id, 'why-local-plan');
  assert.strictEqual(why.hits[0].dir, 'decisions');
  assert.strictEqual(S.find(d, 'heredoc').hits[0].layer, 'touch');
  assert.strictEqual(S.find(d, 'подоболочке').hits[0].layer, 'core');
});

test('find: query syntax of FTS5 in the words is harmless', () => {
  const d = memory(SET);
  for (const q of ['"', 'a OR', 'NEAR(x y)', '*', 'heredoc AND -x', "prisma'); DROP", '']) {
    assert.doesNotThrow(() => S.find(d, q), q);
  }
});

test('a lesson written by another process is found without restart; an edit is seen too', () => {
  const d = memory(SET);
  assert.deepStrictEqual(S.find(d, 'mailpit').hits, []);
  const code = `require('fs').writeFileSync(${JSON.stringify(path.join(d, 'lessons', 'mail-check.md'))}, ${JSON.stringify(
    lesson('mail-check', 'Письма дев-стенда смотреть в mailpit, не в логах.', { keys: ['mailpit'] }))})`;
  execFileSync(process.execPath, ['-e', code]);
  assert.strictEqual(S.find(d, 'mailpit').hits[0].id, 'mail-check');
  const f = path.join(d, 'lessons', 'mail-check.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('mailpit, не в логах', 'mailhog, не в логах'));
  assert.strictEqual(S.find(d, 'mailhog').hits[0].id, 'mail-check');
});

test('index: deleted or garbage index is rebuilt within 1 s and the search still answers', () => {
  const d = memory(SET);
  S.ensureIndex(d);
  const db = path.join(d, '.index.db');
  assert.ok(fs.existsSync(db));
  fs.rmSync(db);
  let t0 = Date.now();
  assert.strictEqual(S.find(d, 'heredoc').hits[0].id, 'bash-heredoc');
  assert.ok(Date.now() - t0 < 1000);
  fs.writeFileSync(db, 'not a database at all');
  t0 = Date.now();
  assert.strictEqual(S.find(d, 'heredoc').hits[0].id, 'bash-heredoc');
  assert.ok(Date.now() - t0 < 1000);
  const again = S.ensureIndex(d);
  assert.strictEqual(again.rebuilt, false);
});

test('index = fold of files and events; the JS engine answers like FTS5', () => {
  const d = memory(SET);
  S.shown(d, 'bash-heredoc', { session_id: 's1' });
  S.repeat(d, 'bash-heredoc', { session_id: 's1' });
  S.ensureIndex(d);
  assert.deepStrictEqual(S.indexFold(d), S.fold(d));
  assert.deepStrictEqual(S.fold(d).stats['bash-heredoc'], { shown: 1, repeat: 1, merged: 0, superseded: 0, retired: 0,
    last: S.fold(d).stats['bash-heredoc'].last });
  const hit = S.find(d, 'heredoc').hits[0];
  assert.strictEqual(hit.shown, 1);
  assert.strictEqual(hit.repeat, 1);
  const js = S.find(d, 'генерацию клиента призмы перед тестами', { engine: 'js' });
  assert.strictEqual(js.engine, 'js');
  assert.strictEqual(js.hits[0].id, 'prisma-before-tests');
});

test('add: validated, written whole, refused when invalid or taken', () => {
  const d = memory(SET);
  const ok = S.addLesson(d, lesson('new-one', 'Новый урок про очередь задач и замок.'));
  assert.deepStrictEqual(ok.problems, []);
  assert.ok(fs.existsSync(path.join(d, 'lessons', 'new-one.md')));
  assert.strictEqual(S.addLesson(d, lesson('new-one', 'Ещё раз.')).ok, false);
  const bad = S.addLesson(d, lesson('bad-one', 'Пушь `git push --force` всегда.'));
  assert.strictEqual(bad.ok, false);
  assert.ok(!fs.existsSync(path.join(d, 'lessons', 'bad-one.md')));
  const dec = S.addLesson(d, lesson('dec-one', 'Решение: одно устройство памяти.', { kind: 'decision' }), { dir: 'decisions' });
  assert.ok(dec.ok, dec.problems.join('; '));
  assert.ok(fs.existsSync(path.join(d, 'decisions', 'dec-one.md')));
});

test('status operations: retire, merge, supersede — the frontmatter line changes, the rest of the file stays, events written', () => {
  const d = memory(SET);
  const f = (id) => path.join(d, 'lessons', `${id}.md`);
  const before = fs.readFileSync(f('prisma-before-tests'), 'utf8');
  S.retire(d, 'prisma-before-tests', { session_id: 's9', note: 'клиент генерируется сам' });
  assert.strictEqual(fs.readFileSync(f('prisma-before-tests'), 'utf8'), before.replace('status: active', 'status: retired'));
  assert.deepStrictEqual(S.find(d, 'prisma').hits, []);
  S.merge(d, 'bash-heredoc', 'cd-subshell', { session_id: 's9' });
  assert.match(fs.readFileSync(f('bash-heredoc'), 'utf8'), /status: superseded/);
  assert.match(fs.readFileSync(f('cd-subshell'), 'utf8'), /supersedes: \[bash-heredoc\]/);
  fs.writeFileSync(f('cd-new'), lesson('cd-new', 'Папка — абсолютным путём или подоболочкой.', { supersedes: ['cd-subshell'] }));
  S.supersede(d, 'cd-subshell', 'cd-new', {});
  assert.match(fs.readFileSync(f('cd-subshell'), 'utf8'), /status: superseded/);
  assert.match(fs.readFileSync(f('cd-new'), 'utf8'), /supersedes: \[cd-subshell\]/);
  const kinds = S.why(d, 'bash-heredoc').events.map((e) => [e.kind, e.into || null]);
  assert.deepStrictEqual(kinds, [['merged', 'cd-subshell']]);
  assert.strictEqual(S.why(d, 'prisma-before-tests').events[0].note, 'клиент генерируется сам');
  assert.throws(() => S.retire(d, 'no-such', {}), /no-such/);
  assert.throws(() => S.retire(d, 'no-push-once', {}), /одного раза|once/);
});

test('why: the lesson, its file and the events about it (why it was shown)', () => {
  const d = memory(SET);
  S.shown(d, 'cd-subshell', { session_id: 's1', tool_use_id: 'tu-7', epoch: 1, mode: 'hook' });
  const w = S.why(d, 'cd-subshell');
  assert.strictEqual(w.file, 'memory/lessons/cd-subshell.md');
  assert.strictEqual(w.lesson.meta.status, 'core');
  assert.deepStrictEqual(w.events.map((e) => [e.kind, e.tool_use_id]), [['shown', 'tu-7']]);
});

test('triggers: active and core lessons with `when`, compiled problems left out; rebuilt by signature only', () => {
  const d = memory(SET);
  fs.writeFileSync(path.join(d, 'lessons', 'bad-when.md'), lesson('bad-when', 'Урок с битым триггером.', { when: [{ cmd: 'a(b' }] }));
  const r = S.ensureTriggers(d);
  assert.strictEqual(r.rebuilt, true);
  const t = S.readTriggers(d);
  assert.deepStrictEqual(t.lessons.map((l) => l.id).sort(), ['bash-heredoc', 'cd-subshell']);
  assert.deepStrictEqual(t.lessons.find((l) => l.id === 'cd-subshell').when, [{ tool: '^Bash$', cmd: '^cd\\s' }]);
  assert.strictEqual(S.ensureTriggers(d).rebuilt, false);
  S.shown(d, 'cd-subshell', {});
  assert.strictEqual(S.ensureTriggers(d).rebuilt, false, 'events do not touch the hot-path file');
});

test('check: names a NUL lesson, a torn event line, a broken index — and nothing blocks', () => {
  const d = memory(SET);
  S.shown(d, 'cd-subshell', {});
  S.ensureIndex(d);
  fs.appendFileSync(path.join(d, 'lessons', 'bash-heredoc.md'), 'хвост\u0000\n');
  const ev = fs.readdirSync(path.join(d, 'events'))[0];
  fs.appendFileSync(path.join(d, 'events', ev), '{"kind":"sho');
  fs.writeFileSync(path.join(d, '.index.db'), 'garbage');
  const c = S.check(d);
  const all = c.problems.join('\n');
  assert.match(all, /bash-heredoc\.md[^\n]*NUL/);
  assert.match(all, new RegExp(`${ev.replace('.', '\\.')}:2`));
  assert.match(all, /индекс/);
  assert.strictEqual(S.find(d, 'heredoc').hits[0].id, 'bash-heredoc');
});

test('export → import: the same set of files byte for byte (NUL and non-UTF-8 included); derived files left out', () => {
  const d = memory(SET);
  S.shown(d, 'cd-subshell', { session_id: 's1' });
  fs.writeFileSync(path.join(d, 'lessons', 'raw.md'), Buffer.from([0x2d, 0xff, 0x00, 0x0a]));
  S.ensureIndex(d);
  S.ensureTriggers(d);
  const bundle = JSON.parse(JSON.stringify(S.exportAll(d)));
  assert.ok(!bundle.files.some((f) => f.path.startsWith('.')));
  const e = path.join(tmp(), 'memory');
  S.importAll(e, bundle);
  const list = (root) => fs.readdirSync(root, { recursive: true }).filter((p) => !p.startsWith('.') && fs.statSync(path.join(root, p)).isFile()).sort();
  assert.deepStrictEqual(list(e), list(d));
  for (const p of list(d)) assert.ok(fs.readFileSync(path.join(e, p)).equals(fs.readFileSync(path.join(d, p))), p);
  assert.throws(() => S.importAll(e, { format: bundle.format, files: [{ path: '../evil.md', enc: 'utf8', data: 'x' }] }), /evil/);
});

test('export v1: errors.md and errors-index.md that the v1 session brief reads', () => {
  const d = memory(SET);
  const v1 = S.exportV1(d, { name: 'demo' });
  assert.match(v1['errors.md'], /^- Скрипт с кавычками — файлом через Write[^\n]*\(2026-11-01, урок bash-heredoc\)$/m);
  assert.match(v1['decisions.md'], /План перестройки лежит локально/);
  for (const l of v1['errors-index.md'].split('\n')) assert.ok([...l].length <= 160, l);
  assert.doesNotMatch(v1['errors-index.md'], /Старый урок про порты/);
  const hub = tmp('hub-');
  const proj = path.join(hub, 'projects', 'demo');
  fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'memory', 'errors-index.md'), v1['errors-index.md']);
  fs.writeFileSync(path.join(proj, 'brief.json'), JSON.stringify({ indexSections: ['Ядро'] }));
  const { buildBrief } = require('../../hooks/session-start.cjs');
  const brief = buildBrief(proj, hub);
  assert.match(brief, /Переход в папку — только в подоболочке/);
  assert.match(brief, /по касанию: [^\n]*ключи: [^\n]*heredoc/);
  assert.doesNotMatch(brief, /индекс ошибок: \d+ строк/);
});

test('retirement candidates: rules not shown for N days; class «once», core and archive never', () => {
  const d = memory(SET);
  S.shown(d, 'bash-heredoc', { at: '2026-11-20T00:00:00.000Z' });
  const now = new Date('2026-12-15T00:00:00Z');
  assert.deepStrictEqual(S.retirementCandidates(d, { days: 30, now }), ['prisma-before-tests']);
  assert.deepStrictEqual(S.retirementCandidates(d, { days: 10, now }).sort(), ['bash-heredoc', 'prisma-before-tests']);
});

test('memoryDir: the project memory from a cwd inside it; no lessons/ — the old format', () => {
  const hub = tmp('hub-');
  const proj = path.join(hub, 'projects', 'demo');
  fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'worktrees', 'K-1'), { recursive: true });
  assert.deepStrictEqual(S.memoryDir(path.join(proj, 'worktrees', 'K-1'), hub), { dir: path.join(proj, 'memory'), newFormat: false });
  fs.mkdirSync(path.join(proj, 'memory', 'lessons'));
  assert.strictEqual(S.memoryDir(proj, hub).newFormat, true);
  assert.strictEqual(S.memoryDir(os.tmpdir(), hub), null);
});
