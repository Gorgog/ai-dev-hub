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
const { readEvents } = require('./events.cjs');

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
  assert.strictEqual(w.file, path.join(d, 'lessons', 'cd-subshell.md')); // absolute: Read takes it from any cwd
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
  const tornAt = fs.readFileSync(path.join(d, 'events', ev), 'utf8').split('\n').length; // physical line of the fragment
  assert.match(all, new RegExp(`${ev.replace('.', '\\.')}:${tornAt}`));
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

test('export → import keeps events/archive/ (months folded by memory-gc), byte for byte; other nesting refused', () => {
  const d = memory(SET);
  S.shown(d, 'cd-subshell', { session_id: 's1' });
  fs.mkdirSync(path.join(d, 'events', 'archive'), { recursive: true });
  const src = '{"at":"2026-07-01T00:00:00.000Z","kind":"shown","lesson":"cd-subshell"}\n';
  fs.writeFileSync(path.join(d, 'events', 'archive', '2026-07.jsonl'), src);
  const bundle = JSON.parse(JSON.stringify(S.exportAll(d)));
  assert.ok(bundle.files.some((f) => f.path === 'events/archive/2026-07.jsonl'), 'archive month exported');
  const e = path.join(tmp(), 'memory');
  S.importAll(e, bundle);
  assert.strictEqual(fs.readFileSync(path.join(e, 'events', 'archive', '2026-07.jsonl'), 'utf8'), src);
  assert.throws(() => S.importAll(e, { format: bundle.format, files: [{ path: 'events/x/y.jsonl', enc: 'utf8', data: '' }] }), /events\/x/);
  assert.throws(() => S.importAll(e, { format: bundle.format, files: [{ path: 'lessons/archive/y.md', enc: 'utf8', data: '' }] }), /lessons\/archive/);
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

// Review round 1 (05.11).
test('triggers follow the files on every search and status operation, not only on check', () => {
  const d = memory(SET);
  S.find(d, 'heredoc');
  assert.deepStrictEqual(S.readTriggers(d).lessons.map((l) => l.id).sort(), ['bash-heredoc', 'cd-subshell']);
  fs.writeFileSync(path.join(d, 'lessons', 'two.md'), lesson('two', 'Второй урок с триггером.', { when: [{ cmd: 'two\\s' }] }));
  S.find(d, 'второй');
  assert.ok(S.readTriggers(d).lessons.some((l) => l.id === 'two'));
  S.retire(d, 'two', {});
  assert.ok(!S.readTriggers(d).lessons.some((l) => l.id === 'two'));
  S.merge(d, 'bash-heredoc', 'cd-subshell', {});
  assert.deepStrictEqual(S.readTriggers(d).lessons.map((l) => l.id), ['cd-subshell']);
});

test('triggers leave out a lesson the validator refuses (external source in the core)', () => {
  const d = memory(SET);
  fs.writeFileSync(path.join(d, 'lessons', 'ext.md'), lesson('ext', 'Внешний текст в ядре.', { source: 'внешний текст', status: 'core',
    kind: 'knowledge', when: [{ cmd: 'ext' }] }));
  S.ensureTriggers(d);
  assert.ok(!S.readTriggers(d).lessons.some((l) => l.id === 'ext'));
});

test('an event alone makes the index stale: counters in find and the fold follow it', () => {
  const d = memory(SET);
  S.ensureIndex(d);
  S.shown(d, 'bash-heredoc', { session_id: 's1' });
  assert.strictEqual(S.find(d, 'heredoc').hits[0].shown, 1);
  assert.deepStrictEqual(S.indexFold(d), S.fold(d));
  assert.strictEqual(S.ensureIndex(d).rebuilt, false);
});

test('the first line is the first non-empty line of the text', () => {
  const d = memory(SET);
  fs.writeFileSync(path.join(d, 'lessons', 'blank.md'), lesson('blank', 'x').replace(/---\nx\n/, '---\n\nНастоящая первая строка про пробелы.\n'));
  assert.strictEqual(S.find(d, 'пробелы').hits[0].first, 'Настоящая первая строка про пробелы.');
});

test('status operations on a CRLF lesson keep CRLF; a failing supersede writes nothing', () => {
  const d = memory(SET);
  const f = path.join(d, 'lessons', 'crlf.md');
  fs.writeFileSync(f, lesson('crlf', 'Урок с CRLF.').replace(/\n/g, '\r\n'));
  S.retire(d, 'crlf', {});
  const t = fs.readFileSync(f, 'utf8');
  assert.match(t, /\r\nstatus: retired\r\n/);
  assert.doesNotMatch(t.replace(/\r\n/g, ''), /\n/);
  fs.writeFileSync(path.join(d, 'lessons', 'broken.md'), 'нет frontmatter\nвообще\n');
  const before = fs.readFileSync(path.join(d, 'lessons', 'prisma-before-tests.md'), 'utf8');
  assert.throws(() => S.supersede(d, 'broken', 'prisma-before-tests', {}), /frontmatter/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'lessons', 'prisma-before-tests.md'), 'utf8'), before);
  assert.throws(() => S.supersede(d, 'prisma-before-tests', 'broken', {}), /frontmatter/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'lessons', 'prisma-before-tests.md'), 'utf8'), before);
  assert.strictEqual(S.why(d, 'prisma-before-tests').events.length, 0);
});

test('check on a node without node:sqlite does not report a broken index', () => {
  const d = memory(SET);
  S.ensureIndex(d);
  const code = `const S=require(${JSON.stringify(path.join(__dirname, 'store.cjs'))});process.stdout.write(JSON.stringify(S.check(${JSON.stringify(d)}).problems))`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...process.env, HUB_MEMORY_ENGINE: 'js' }, encoding: 'utf8' }));
  assert.deepStrictEqual(out, []);
});

test('find and why give an absolute file path that exists', () => {
  const d = memory(SET);
  const h = S.find(d, 'heredoc').hits[0];
  assert.ok(path.isAbsolute(h.file) && fs.existsSync(h.file), h.file);
  assert.ok(fs.existsSync(S.why(d, 'why-local-plan').file));
});

// Review round 2 (05.11).
test('status operations on mixed line endings (LF frontmatter, a CRLF body line) — work, the body bytes kept', () => {
  const d = memory(SET);
  const f = path.join(d, 'lessons', 'mix.md');
  const text = lesson('mix', 'Первая строка урока.').replace('Первая строка урока.\n', 'Первая строка урока.\r\n');
  fs.writeFileSync(f, text);
  S.retire(d, 'mix', {});
  assert.strictEqual(fs.readFileSync(f, 'utf8'), text.replace('status: active', 'status: retired'));
});

// ---------- the core and decision (г) (tail 34) ----------

// 20 core lessons: exactly the ones whose `when` the validator accepts and the lesson hook listens to are proposed;
// class «once», a lesson without `when` and a trigger only on calls the hook does not listen to stay in the core.
const CORE20 = [
  ['c-rule-bash', 'Правило ядра с триггером на Bash.', { status: 'core', when: [{ tool: '^Bash$', cmd: '\\bnpm\\s+test\\b' }] }],
  ['c-rule-cmd-only', 'Правило ядра с триггером только по команде.', { status: 'core', when: [{ cmd: '\\bprisma\\s+migrate\\b' }] }],
  ['c-rule-edit', 'Правило ядра с триггером на правку файла.', { status: 'core', when: [{ tool: '^(Edit|Write)$', path: '\\.vue$' }] }],
  ['c-rule-mixed', 'Правило ядра: один триггер на Agent, второй на Bash.', { status: 'core',
    when: [{ tool: '^Agent$', body: 'ревью' }, { tool: '^Bash$', cmd: 'playwright' }] }],
  ['c-knowledge-bash', 'Знание ядра с триггером на Bash.', { kind: 'knowledge', status: 'core', when: [{ tool: '^Bash$', cmd: '\\bdocker\\b' }] }],
  ['c-rule-out', 'Правило ядра с триггером по выводу.', { status: 'core', when: [{ out: 'ENOSPC' }] }],
  ['c-rule-agent', 'Правило ядра с триггером только на Agent.', { status: 'core', when: [{ tool: '^Agent$', body: 'ревью' }] }],
  ['c-rule-task', 'Правило ядра с триггером только на Task.', { status: 'core', when: [{ tool: '^Task$' }] }],
  ['c-rule-mcp', 'Правило ядра с триггером на MCP трекера.', { status: 'core', when: [{ tool: 'tracker_issue$' }] }],
  ['c-rule-chrome', 'Правило ядра с триггером на MCP браузера.', { status: 'core',
    when: [{ tool: '^mcp__claude-in-chrome__javascript_tool$', body: 'nova' }] }],
  ['c-rule-badrx', 'Правило ядра с битым регэкспом.', { status: 'core', when: [{ tool: '^Bash$', cmd: '(' }] }],
  ['c-rule-nowhen', 'Правило ядра без триггера.', { status: 'core' }],
  ['c-knowledge-nowhen', 'Знание ядра без триггера.', { kind: 'knowledge', status: 'core' }],
  ['c-once-bash', 'Класс одного раза с триггером на Bash.', { kind: 'once', status: 'core', when: [{ tool: '^Bash$', cmd: 'sudo' }] }],
  ['c-once-nowhen', 'Класс одного раза без триггера.', { kind: 'once', status: 'core' }],
  ['c-once-edit', 'Класс одного раза с триггером на правку.', { kind: 'once', status: 'core', when: [{ tool: '^Write$', path: '\\.env' }] }],
  ['c-once-mcp', 'Класс одного раза с триггером на MCP.', { kind: 'once', status: 'core', when: [{ tool: 'gitlab_mr_create$' }] }],
  ['c-once-agent', 'Класс одного раза с триггером на Agent.', { kind: 'once', status: 'core', when: [{ tool: '^Agent$' }] }],
  ['c-rule-external', 'Внешний текст в ядре с триггером на Bash.', { status: 'core', source: 'внешний', when: [{ tool: '^Bash$' }] }],
  ['c-rule-unknown-field', 'Правило ядра с неизвестным полем триггера.', { status: 'core', when: [{ tool: '^Bash$', file: 'x' }] }],
  ['a-rule-bash', 'Правило по касанию с триггером на Bash.', { when: [{ tool: '^Bash$', cmd: 'make' }] }],
];
// The matcher of the lesson hook as of 06.11 — fixed here, so a wider matcher in the real hooks.json breaks nothing.
const TODAY = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
const WORKING = ['c-knowledge-bash', 'c-rule-bash', 'c-rule-cmd-only', 'c-rule-edit', 'c-rule-mixed', 'c-rule-out'];

// A plugin root of its own: the lesson hook's event from mechanisms/memory-lessons.json, its matcher from hooks.json.
// Stages: the lesson module and the delivery (without the delivery the module is silent, run.cjs) — on unless given.
function pluginWith(matcher, event = 'PostToolUse', { stage = 'on', delivery = 'on' } = {}) {
  const root = tmp('plugin-');
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.mkdirSync(path.join(root, 'mechanisms'));
  fs.writeFileSync(path.join(root, 'mechanisms', 'memory-lessons.json'), JSON.stringify({ id: 'memory-lessons', handler: 'memory', event, stage }));
  if (delivery) fs.writeFileSync(path.join(root, 'mechanisms', 'delivery.json'), JSON.stringify({ id: 'delivery', handler: 'delivery', stage: delivery }));
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash|Agent|Task|mcp__.*', hooks: [] }],
    [event]: [{ matcher, hooks: [] }],
  } }));
  return root;
}

test('core candidates (decision г): of 20 core lessons exactly the ones with a working trigger, each with its reason', () => {
  const d = memory(CORE20);
  assert.strictEqual(fs.readdirSync(path.join(d, 'lessons')).filter((f) => /^c-/.test(f)).length, 20);
  const got = S.coreCandidates(d, { plugin: pluginWith(TODAY) });
  assert.deepStrictEqual(got.map((c) => c.id), WORKING);
  for (const c of got) {
    assert.match(c.reason, /PostToolUse/, c.id);
    assert.match(c.reason, /when\[\d\]/, c.id);
  }
  assert.match(got.find((c) => c.id === 'c-rule-mixed').reason, /when\[1\][^\n]*Bash/);
  assert.match(got.find((c) => c.id === 'c-rule-edit').reason, /Edit|Write/);
});

test('core candidates follow the matcher of hooks.json (read, not hard-coded): an MCP matcher makes an MCP trigger work', () => {
  const d = memory(CORE20);
  const wide = pluginWith('Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__claude-in-chrome__.*');
  assert.deepStrictEqual(S.coreCandidates(d, { plugin: wide }).map((c) => c.id), [...WORKING, 'c-rule-chrome'].sort());
  const agent = pluginWith('Bash|Agent');
  assert.deepStrictEqual(S.coreCandidates(d, { plugin: agent }).map((c) => c.id),
    ['c-knowledge-bash', 'c-rule-agent', 'c-rule-bash', 'c-rule-cmd-only', 'c-rule-mixed', 'c-rule-out']);
  // The event comes from the mechanism record: the hook moved to another event — that event's matcher counts.
  const moved = pluginWith('Edit', 'PostToolUseFailure');
  // `out` alone does not work there: an Edit answers without stdout (review round 1).
  assert.deepStrictEqual(S.coreCandidates(d, { plugin: moved }).map((c) => c.id), ['c-rule-edit']);
});

test('core candidates: no hook config to read — nothing is proposed (a lesson stays in the core when in doubt)', () => {
  const d = memory(CORE20);
  const none = tmp('plugin-none-');
  assert.deepStrictEqual(S.coreCandidates(d, { plugin: none }), []);
  assert.throws(() => S.lessonHookTools(none), /memory-lessons|hooks\.json/);
});

test('toActive: a core lesson goes to active (frontmatter line only), an event, the triggers keep it; not core — refused', () => {
  const d = memory(CORE20);
  const f = path.join(d, 'lessons', 'c-rule-bash.md');
  const before = fs.readFileSync(f, 'utf8');
  S.toActive(d, 'c-rule-bash', { note: 'решение (г)' });
  const after = fs.readFileSync(f, 'utf8');
  assert.strictEqual(after, before.replace('status: core', 'status: active'));
  const ev = readEvents(d).events.filter((e) => e.lesson === 'c-rule-bash');
  assert.deepStrictEqual(ev.map((e) => e.kind), ['to-active']);
  assert.strictEqual(ev[0].note, 'решение (г)');
  assert.ok(S.readTriggers(d).lessons.some((l) => l.id === 'c-rule-bash' && l.layer === 'touch'));
  assert.throws(() => S.toActive(d, 'c-rule-bash'), /не в ядре/);
  assert.throws(() => S.toActive(d, 'a-rule-bash'), /не в ядре/);
  assert.deepStrictEqual(S.coreCandidates(d, { plugin: pluginWith(TODAY) }).map((c) => c.id), WORKING.filter((id) => id !== 'c-rule-bash'));
});

test('workingTrigger: the validator and the listened tools decide; the reason names the item', () => {
  const ok = S.workingTrigger({ when: [{ tool: '^Agent$' }, { tool: '^Bash$', cmd: 'x' }] }, { tools: ['Bash', 'Edit'] });
  assert.strictEqual(ok.ok, true);
  assert.match(ok.reason, /when\[1\]/);
  assert.strictEqual(S.workingTrigger({ when: [] }, { tools: ['Bash'] }).ok, false);
  assert.strictEqual(S.workingTrigger({ when: [{ tool: '^Agent$' }] }, { tools: ['Bash'] }).ok, false);
  assert.strictEqual(S.workingTrigger({ when: [{ tool: 'tracker_issue$' }] }, { tools: ['Bash', 'mcp__claude-in-chrome__.*'] }).ok, false);
  assert.strictEqual(S.workingTrigger({ when: [{ tool: '^mcp__claude-in-chrome__navigate$' }] }, { tools: ['mcp__claude-in-chrome__.*'] }).ok, true);
});

test('lessonHookTools by default: the event of mechanisms/memory-lessons.json and its matcher in hooks/hooks.json', () => {
  const root = path.join(__dirname, '..', '..');
  const event = JSON.parse(fs.readFileSync(path.join(root, 'mechanisms', 'memory-lessons.json'), 'utf8')).event;
  const groups = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks[event];
  const t = S.lessonHookTools();
  assert.strictEqual(t.event, event);
  assert.deepStrictEqual(t.tools, groups.flatMap((g) => g.matcher.split('|')));
});

test('keepInCore: the decision «stays in the core» is an event with the lesson sha; not proposed until the lesson is edited', () => {
  const d = memory(CORE20);
  const opts = { plugin: pluginWith(TODAY) };
  S.keepInCore(d, 'c-rule-bash', { note: 'стенд через MCP' });
  const ev = readEvents(d).events.filter((e) => e.lesson === 'c-rule-bash');
  assert.deepStrictEqual(ev.map((e) => [e.kind, e.note]), [['kept-core', 'стенд через MCP']]);
  assert.match(ev[0].sha, /^[0-9a-f]{12}$/);
  assert.deepStrictEqual(S.coreCandidates(d, opts).map((c) => c.id), WORKING.filter((id) => id !== 'c-rule-bash'));
  // The lesson was edited — the old decision is about another text: proposed again.
  const f = path.join(d, 'lessons', 'c-rule-bash.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Вторая строка урока.', 'Вторая строка урока, правленая.'));
  assert.deepStrictEqual(S.coreCandidates(d, opts).map((c) => c.id), WORKING);
  assert.throws(() => S.keepInCore(d, 'a-rule-bash'), /не в ядре/);
  assert.strictEqual(S.check(d).problems.filter((p) => /events/.test(p)).length, 0);
});

// Review round 1 (HIGH-1): a field the hook never fills for that tool is no working trigger — the fields come from the
// hook's own fieldsOf on a call of that tool: Write/Edit have no stdout (out is empty), Agent has no path, «bash» is Bash.
test('workingTrigger: a field the hook leaves empty for the tool does not work (out on Write, path on Agent, body on Bash)', () => {
  const t = (w, tools = TODAY.split('|')) => S.workingTrigger({ when: [w] }, { tools }).ok;
  assert.strictEqual(t({ tool: '^Write$', out: 'has been updated' }), false);
  assert.strictEqual(t({ tool: '^(Edit|Write)$', out: 'x' }), false);
  assert.strictEqual(t({ tool: '^Bash$', out: 'ENOSPC' }), true);
  assert.strictEqual(t({ tool: '^Bash$', body: 'x' }), false);
  assert.strictEqual(t({ tool: '^Write$', body: 'x', path: '\\.env' }), true);
  assert.strictEqual(t({ tool: '^Agent$', path: 'x' }, ['Agent']), false);
  assert.strictEqual(t({ tool: '^Agent$', body: 'ревью' }, ['Agent']), true);
  assert.strictEqual(t({ tool: '^bash$', path: 'x' }, ['*']), false);
  assert.strictEqual(t({ tool: '^bash$', cmd: 'x' }, ['*']), true);
  // The out of an MCP call is whatever the hook's fieldsOf makes of its answer (slice 35 fills it from the content
  // blocks): the expectation is that same fieldsOf on an MCP call, not a constant — true or false by the hook in place.
  const { fieldsOf } = require('../../hooks/memory-hot.cjs');
  const mcpOut = fieldsOf({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: 'x' },
    tool_response: [{ type: 'text', text: 'x' }] }, { withOut: true }).out.trim() !== '';
  assert.strictEqual(t({ tool: '^mcp__claude-in-chrome__navigate$', out: 'x' }, ['mcp__claude-in-chrome__.*']), mcpOut);
  assert.strictEqual(t({ tool: '^mcp__claude-in-chrome__navigate$', path: 'x' }, ['mcp__claude-in-chrome__.*']), false,
    'path of an MCP call — never filled for a tool the hook does not know');
  assert.strictEqual(t({ out: 'x' }, ['Write', 'Edit']), false, 'no tool, only Write/Edit listened — out never filled');
});

// Review round 1 (MEDIUM-1): the lesson module has to run in the project — its stage and the delivery's, as run.cjs.
test('core candidates only where the lesson module runs: stage off, canary not listed, no delivery — nothing', () => {
  const d = memory(CORE20);
  const proj = path.dirname(d);
  const ids = (plugin) => S.coreCandidates(d, { plugin }).map((c) => c.id);
  assert.deepStrictEqual(ids(pluginWith(TODAY, 'PostToolUse', { stage: 'off' })), []);
  assert.deepStrictEqual(ids(pluginWith(TODAY, 'PostToolUse', { delivery: null })), []);
  assert.deepStrictEqual(ids(pluginWith(TODAY, 'PostToolUse', { delivery: 'off' })), []);
  // A delivery record without a stage: the spine turns the delivery on only by an explicit on/canary (review round 2).
  const nostage = pluginWith(TODAY, 'PostToolUse', { delivery: 'x' });
  fs.writeFileSync(path.join(nostage, 'mechanisms', 'delivery.json'), JSON.stringify({ id: 'delivery', handler: 'delivery' }));
  assert.deepStrictEqual(ids(nostage), []);
  // The module itself without a stage — on, as any module of the spine.
  const modnostage = pluginWith(TODAY);
  fs.writeFileSync(path.join(modnostage, 'mechanisms', 'memory-lessons.json'), JSON.stringify({ id: 'memory-lessons', event: 'PostToolUse' }));
  assert.deepStrictEqual(ids(modnostage), WORKING);
  const canary = pluginWith(TODAY, 'PostToolUse', { stage: 'canary', delivery: 'canary' });
  assert.deepStrictEqual(ids(canary), [], 'canary, project not listed');
  fs.writeFileSync(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['memory'] }));
  assert.deepStrictEqual(ids(canary), [], 'the lesson module listed by handler, the delivery not');
  fs.writeFileSync(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['memory', 'delivery'] }));
  assert.deepStrictEqual(ids(canary), WORKING);
  const h = S.lessonHookTools(canary, { project: proj });
  assert.strictEqual(h.on, true);
  assert.strictEqual(S.lessonHookTools(pluginWith(TODAY, 'PostToolUse', { stage: 'off' }), { project: proj }).on, false);
});

test('keptInCore: only decisions about the text as it is and lessons still in the core', () => {
  const d = memory(CORE20);
  S.keepInCore(d, 'c-rule-bash', { note: 'x' });
  S.keepInCore(d, 'c-rule-edit', { note: 'x' });
  assert.deepStrictEqual(S.keptInCore(d), ['c-rule-bash', 'c-rule-edit']);
  const f = path.join(d, 'lessons', 'c-rule-edit.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Вторая строка урока.', 'Правлено.'));
  S.toActive(d, 'c-rule-bash');
  assert.deepStrictEqual(S.keptInCore(d), []);
});
