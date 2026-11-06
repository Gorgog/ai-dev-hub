// node --test plugin/skills/memory-gc/scripts/gc.test.cjs — memory-gc over memory v2 (plugin/lib/memory/store.cjs):
// near duplicates, retirement by condition, review after a model change; a v1 project is left as it is.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { formatLesson } = require('../../../lib/memory/format.cjs');
const { appendEvent, readEvents, foldEvents } = require('../../../lib/memory/events.cjs');

const CLI = path.join(__dirname, 'gc.cjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const lesson = (id, first, more = {}) => formatLesson({ id, kind: more.kind || 'rule', when: [], keys: more.keys || [],
  status: more.status || 'active', supersedes: [], source: 'модель', created: more.created || '2026-11-01' },
[first, more.second || 'Вторая строка урока.']);

function memory() {
  const mem = path.join(tmp('gc-'), 'memory');
  fs.mkdirSync(path.join(mem, 'lessons'), { recursive: true });
  const put = (id, first, more) => fs.writeFileSync(path.join(mem, 'lessons', `${id}.md`), lesson(id, first, more));
  put('prisma-after-checkout', 'После смены ветки — генерация клиента prisma до юнит-тестов.', { keys: ['prisma', 'checkout'] });
  put('prisma-stale-client', 'Красные тесты после смены ветки — сначала свежий ли клиент prisma.', { keys: ['prisma', 'тесты'] });
  put('dev-port', 'Дев-сервер слушает порт 3000 — проверка в браузере на localhost:3000.', { keys: ['порт'] });
  put('old-rule', 'Линтер запускать только по своим файлам ветки.', { keys: ['линтер'], created: '2026-08-01' });
  put('old-once', 'Файлы .env не править: там секреты.', { kind: 'once', status: 'core', keys: ['env'], created: '2026-08-01' });
  return mem;
}
const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('dups: two lessons about one thing are named as a pair, unrelated ones are not', () => {
  const mem = memory();
  const r = run(['--memory', mem, 'dups']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /prisma-after-checkout ↔ prisma-stale-client|prisma-stale-client ↔ prisma-after-checkout/);
  assert.doesNotMatch(r.out, /dev-port ↔|↔ dev-port/);
  assert.doesNotMatch(r.out, /old-rule ↔|↔ old-rule/);
});

test('retire: an old rule nobody saw is a candidate; class «once» and a recently shown rule are not', () => {
  const mem = memory();
  appendEvent(mem, { at: '2026-11-04T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
  const r = run(['--memory', mem, 'retire', '--days', '30', '--now', '2026-11-05']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /old-rule/);
  assert.doesNotMatch(r.out, /old-once|dev-port/);
  // A proposal only: the lesson stays active until the agent runs `recall retire` after the user's «да».
  assert.match(fs.readFileSync(path.join(mem, 'lessons', 'old-rule.md'), 'utf8'), /status: active/);
});

test('review: after a model change every live lesson is marked once; same model again — nothing; reviewed clears', () => {
  const mem = memory();
  appendEvent(mem, { at: '2026-11-01T10:00:00.000Z', kind: 'shown', lesson: 'dev-port', model: 'model-a' });
  let r = run(['--memory', mem, 'review', '--model', 'model-a']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /модель не менялась/);
  assert.strictEqual(readEvents(mem).events.filter((e) => e.kind === 'review').length, 0);

  r = run(['--memory', mem, 'review', '--model', 'model-b']);
  assert.strictEqual(r.code, 0, r.err);
  const marked = readEvents(mem).events.filter((e) => e.kind === 'review');
  assert.deepStrictEqual(marked.map((e) => e.lesson).sort(),
    ['dev-port', 'old-once', 'old-rule', 'prisma-after-checkout', 'prisma-stale-client']);
  assert.ok(marked.every((e) => e.model === 'model-b' && /model-a → model-b/.test(e.note)));

  r = run(['--memory', mem, 'review', '--model', 'model-b']); // idempotent: the change is already marked
  assert.strictEqual(readEvents(mem).events.filter((e) => e.kind === 'review').length, 5);

  assert.strictEqual(run(['--memory', mem, 'reviewed', 'dev-port']).code, 0);
  const list = run(['--memory', mem, 'review', '--list']).out;
  assert.match(list, /old-rule/);
  assert.doesNotMatch(list, /dev-port/);
});

test('review: no model in the events yet — the first call writes a baseline (reviewed, model) per live lesson; a later model change marks them (decision 05.11)', () => {
  const mem = memory();
  let r = run(['--memory', mem, 'review', '--model', 'model-a']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /опорная модель model-a/);
  const base = readEvents(mem).events;
  assert.deepStrictEqual(base.map((e) => `${e.kind}:${e.model}`), Array(5).fill('reviewed:model-a'));
  assert.ok(base.every((e) => typeof e.lesson === 'string'), 'every memory event names its lesson');
  r = run(['--memory', mem, 'review', '--model', 'model-a']);
  assert.match(r.out, /модель не менялась/);
  r = run(['--memory', mem, 'review', '--model', 'model-b']);
  assert.match(r.out, /model-a → model-b/);
  assert.strictEqual(readEvents(mem).events.filter((e) => e.kind === 'review').length, 5);
});

test('review end to end with the real writer: wind-down `episode.cjs repeat --model` records the model, a new model marks the lessons', () => {
  const mem = memory();
  const ep = path.join(__dirname, '..', '..', 'wind-down', 'scripts', 'episode.cjs');
  const w = spawnSync(process.execPath, [ep, '--memory', mem, 'repeat', 'dev-port', '--note', 'снова', '--model', 'model-a'], { encoding: 'utf8' });
  assert.strictEqual(w.status, 0, w.stderr);
  assert.strictEqual(readEvents(mem).events[0].model, 'model-a');
  const r = run(['--memory', mem, 'review', '--model', 'model-b']);
  assert.match(r.out, /model-a → model-b: на пересмотр поставлено 5/);
});

test('fold keeps the review-family events: reviewed and review stay in a folded month', () => {
  const mem = memory();
  appendEvent(mem, { at: '2026-05-01T10:00:00.000Z', kind: 'reviewed', lesson: 'dev-port', model: 'model-a' });
  appendEvent(mem, { at: '2026-05-02T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
  appendEvent(mem, { at: '2026-05-03T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
  appendEvent(mem, { at: '2026-05-04T10:00:00.000Z', kind: 'review', lesson: 'dev-port', model: 'model-b' });
  assert.strictEqual(run(['--memory', mem, 'fold', '--now', '2026-11-05', '--apply']).code, 0);
  assert.deepStrictEqual(readEvents(mem).events.map((e) => e.kind), ['reviewed', 'shown', 'review']);
  assert.strictEqual(readEvents(mem).problems.length, 0);
});

test('a project of the old format (no memory/lessons/): said so, code 0, nothing created', () => {
  const mem = path.join(tmp('gc-v1-'), 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'errors.md'), '# Правила из ошибок\n');
  for (const cmd of [['dups'], ['retire'], ['review', '--model', 'm']]) {
    const r = run(['--memory', mem, ...cmd]);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /памяти нового формата нет/);
  }
  assert.deepStrictEqual(fs.readdirSync(mem), ['errors.md']);
});

test('fold: a month older than 3 keeps every repeat/merged/superseded/retired and the last shown per lesson; the source goes to events/archive/', () => {
  const mem = memory();
  const lines = [
    { at: '2026-07-01T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' },
    { at: '2026-07-02T10:00:00.000Z', kind: 'repeat', lesson: 'dev-port', note: 'снова' },
    { at: '2026-07-03T10:00:00.000Z', kind: 'shown', lesson: 'old-rule' },
    { at: '2026-07-04T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' },
    { at: '2026-07-05T10:00:00.000Z', kind: 'retired', lesson: 'old-rule' },
    { at: '2026-07-06T10:00:00.000Z', kind: 'shown', lesson: 'old-rule' },
    { at: '2026-07-07T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' },
  ];
  for (const e of lines) appendEvent(mem, e);
  appendEvent(mem, { at: '2026-10-01T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
  appendEvent(mem, { at: '2026-10-02T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
  const src = fs.readFileSync(path.join(mem, 'events', '2026-07.jsonl'));
  const before = foldEvents(readEvents(mem).events);

  const dry = run(['--memory', mem, 'fold', '--now', '2026-11-05']);
  assert.strictEqual(dry.code, 0, dry.err);
  assert.match(dry.out, /2026-07: событий 7 → 4/);
  assert.doesNotMatch(dry.out, /2026-10/);
  assert.deepStrictEqual(fs.readFileSync(path.join(mem, 'events', '2026-07.jsonl')), src, 'без --apply ничего не меняется');

  const r = run(['--memory', mem, 'fold', '--now', '2026-11-05', '--apply']);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(fs.readFileSync(path.join(mem, 'events', 'archive', '2026-07.jsonl')), src, 'исходник — в архиве побайтно');
  const kept = fs.readFileSync(path.join(mem, 'events', '2026-07.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(kept.map((e) => `${e.kind}:${e.lesson}:${e.at.slice(8, 10)}`),
    ['repeat:dev-port:02', 'retired:old-rule:05', 'shown:old-rule:06', 'shown:dev-port:07']);
  assert.strictEqual(fs.readFileSync(path.join(mem, 'events', '2026-10.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
  const after = foldEvents(readEvents(mem).events);
  for (const id of ['dev-port', 'old-rule']) {
    for (const k of ['repeat', 'merged', 'superseded', 'retired', 'last']) assert.strictEqual(after[id][k], before[id][k], `${id}.${k}`);
  }
  // shown of a folded month means «shown in that month»: dev-port 3 → 1 in July, plus 2 in October.
  assert.strictEqual(after['dev-port'].shown, 3);

  const again = run(['--memory', mem, 'fold', '--now', '2026-11-05', '--apply']);
  assert.strictEqual(again.code, 0, again.err);
  assert.match(again.out, /сворачивать нечего/);
  assert.deepStrictEqual(fs.readFileSync(path.join(mem, 'events', 'archive', '2026-07.jsonl')), src, 'архив не перезаписан');
});

test('fold: a torn line of an old month stays in the archive and is named; the month is folded around it', () => {
  const mem = memory();
  appendEvent(mem, { at: '2026-06-01T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
  fs.appendFileSync(path.join(mem, 'events', '2026-06.jsonl'), '{"at":"2026-06-02T1');
  appendEvent(mem, { at: '2026-06-03T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
  const r = run(['--memory', mem, 'fold', '--now', '2026-11-05', '--apply']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /битых строк 1 — только в архиве/);
  assert.match(fs.readFileSync(path.join(mem, 'events', 'archive', '2026-06.jsonl'), 'utf8'), /"at":"2026-06-02T1/);
  assert.strictEqual(readEvents(mem).problems.length, 0);
});

test('fold: a crash after the archive was written (month not yet folded) is finished by the next run; lines written after the archive are added to it', () => {
  const mem = memory();
  for (let d = 1; d <= 3; d++) appendEvent(mem, { at: `2026-05-0${d}T10:00:00.000Z`, kind: 'shown', lesson: 'dev-port' });
  const arch = path.join(mem, 'events', 'archive', '2026-05.jsonl');
  fs.mkdirSync(path.dirname(arch), { recursive: true });
  fs.copyFileSync(path.join(mem, 'events', '2026-05.jsonl'), arch); // the crash: archive written, month not rewritten
  appendEvent(mem, { at: '2026-05-04T10:00:00.000Z', kind: 'repeat', lesson: 'dev-port' }); // a late writer
  const r = run(['--memory', mem, 'fold', '--now', '2026-11-05', '--apply']);
  assert.strictEqual(r.code, 0, r.err);
  const month = fs.readFileSync(path.join(mem, 'events', '2026-05.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(month.map((e) => `${e.kind}:${e.at.slice(8, 10)}`), ['shown:03', 'repeat:04']);
  const a = fs.readFileSync(arch, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(a.length, 4, 'the archive holds every line the month ever had');
});

test('fold: shown events without lesson or rule, or without at, are kept, not merged under one key', () => {
  const mem = memory();
  appendEvent(mem, { at: '2026-05-01T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
  appendEvent(mem, { at: '2026-05-02T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
  fs.appendFileSync(path.join(mem, 'events', '2026-05.jsonl'), '{"at":"2026-05-03T10:00:00.000Z","kind":"shown","key":"x"}\n'
    + '{"at":"2026-05-04T10:00:00.000Z","kind":"shown","key":"y"}\n{"kind":"shown","lesson":"dev-port"}\n');
  assert.strictEqual(run(['--memory', mem, 'fold', '--now', '2026-11-05', '--apply']).code, 0);
  const month = fs.readFileSync(path.join(mem, 'events', '2026-05.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(month.map((e) => `${e.key || e.lesson}:${e.at ? e.at.slice(8, 10) : '-'}`), ['dev-port:02', 'x:03', 'y:04', 'dev-port:-']);
});

test('review: a wind-down repeat written under the new model before gc does not hide the change (review round 2)', () => {
  const mem = memory();
  const ep = path.join(__dirname, '..', '..', 'wind-down', 'scripts', 'episode.cjs');
  assert.match(run(['--memory', mem, 'review', '--model', 'model-a']).out, /опорная модель model-a/);
  const w = spawnSync(process.execPath, [ep, '--memory', mem, 'repeat', 'dev-port', '--note', 'снова', '--model', 'model-b'], { encoding: 'utf8' });
  assert.strictEqual(w.status, 0, w.stderr);
  const r = run(['--memory', mem, 'review', '--model', 'model-b']);
  assert.match(r.out, /на пересмотр поставлено 5/);
  assert.match(run(['--memory', mem, 'review', '--model', 'model-b']).out, /модель не менялась/);
});

test('review: a lesson written after the baseline is not marked under the same model, is marked after a change', () => {
  const mem = memory();
  run(['--memory', mem, 'review', '--model', 'model-a']);
  fs.writeFileSync(path.join(mem, 'lessons', 'late-one.md'), lesson('late-one', 'Урок, записанный после опорной отметки.'));
  assert.match(run(['--memory', mem, 'review', '--model', 'model-a']).out, /модель не менялась/);
  assert.match(run(['--memory', mem, 'review', '--model', 'model-b']).out, /на пересмотр поставлено 6/);
});

test('review before any mark: repeats under A, then under B, then gc under B — still a change', () => {
  const mem = memory();
  appendEvent(mem, { at: '2026-11-01T10:00:00.000Z', kind: 'repeat', lesson: 'dev-port', model: 'model-a' });
  appendEvent(mem, { at: '2026-11-02T10:00:00.000Z', kind: 'repeat', lesson: 'dev-port', model: 'model-b' });
  assert.match(run(['--memory', mem, 'review', '--model', 'model-b']).out, /model-a → model-b: на пересмотр поставлено 5/);
});

test('review: a reviewed mark without a model (reviewed before any review) does not count — the first review is the baseline', () => {
  const mem = memory();
  assert.strictEqual(run(['--memory', mem, 'reviewed', 'dev-port']).code, 0);
  const r = run(['--memory', mem, 'review', '--model', 'model-a']);
  assert.match(r.out, /опорная модель model-a/);
  assert.doesNotMatch(run(['--memory', mem, 'review', '--list']).out, /undefined/);
});

// Slice 32: fold rewrites a month by tmp + rename. A writer that opened the month before the rename appends into the
// old inode — its event used to vanish with it. The month is folded under the events lock, and what the old inode got
// after the read is carried over into the new month.
function foldRace(stage) {
  const mem = memory();
  for (let d = 1; d <= 3; d++) appendEvent(mem, { at: `2026-05-0${d}T10:00:00.000Z`, kind: 'shown', lesson: 'dev-port' });
  const month = path.join(mem, 'events', '2026-05.jsonl');
  const { main } = require('./gc.cjs');
  const real = fs.renameSync;
  let staged = null;
  fs.renameSync = function (from, to) {
    if (to === month && staged === null) staged = stage(mem, month);
    return real.call(this, from, to);
  };
  let out;
  try { out = main(['--memory', mem, 'fold', '--now', '2026-11-05', '--apply']); } finally { fs.renameSync = real; }
  return { mem, month, out, staged };
}

test('fold: an event appended to the month while it is being rewritten is not lost (slice 32)', () => {
  const late = JSON.stringify({ at: '2026-05-04T10:00:00.000Z', kind: 'repeat', lesson: 'dev-port', note: 'поздний' });
  // A writer without the lock (the \n frame: no node:sqlite, or the lock was stuck) holds the old inode open.
  const { mem, out } = foldRace((m, month) => { fs.appendFileSync(month, `\n${late}\n`); return true; });
  assert.match(out, /2026-05: событий 3 → 1/);
  const kinds = readEvents(mem).events.filter((e) => e.at.startsWith('2026-05')).map((e) => `${e.kind}:${e.at.slice(8, 10)}`);
  assert.deepStrictEqual(kinds, ['shown:03', 'repeat:04']);
  assert.deepStrictEqual(readEvents(mem).problems, []);
  // The archive is «the month as it was», the late line included: a later fold has nothing to fold (review 1).
  assert.match(fs.readFileSync(path.join(mem, 'events', 'archive', '2026-05.jsonl'), 'utf8'), /"note":"поздний"/);
  assert.match(require('./gc.cjs').main(['--memory', mem, 'fold', '--now', '2026-11-05', '--apply']), /сворачивать нечего/);
});

test('fold: the month is rewritten under the events lock — a locked writer cannot get in between (slice 32)', { skip: !require('../../../lib/memory/sqlite.cjs')() && 'no node:sqlite' }, () => {
  const D = require('../../../lib/memory/sqlite.cjs')();
  const { staged } = foldRace((m) => {
    const db = new D(path.join(m, '.events.lock.db'), { timeout: 0 });
    try { db.exec('BEGIN EXCLUSIVE'); db.exec('COMMIT'); return 'free'; } catch (e) { return `held: ${e.message}`; } finally { db.close(); }
  });
  assert.match(String(staged), /^held/, 'the events lock is held while the month is renamed');
});

// ---------- core: decision (г) (tail 34) ----------

const withWhen = (id, first, more = {}) => formatLesson({ id, kind: more.kind || 'rule', when: more.when || [], keys: [],
  status: more.status || 'core', supersedes: [], source: 'модель', created: '2026-11-01' }, [first, 'Вторая строка урока.']);
function coreMemory() {
  const mem = path.join(tmp('gc-core-'), 'memory');
  fs.mkdirSync(path.join(mem, 'lessons'), { recursive: true });
  const put = (id, first, more) => fs.writeFileSync(path.join(mem, 'lessons', `${id}.md`), withWhen(id, first, more));
  put('core-bash-rule', 'Правило ядра с триггером на Bash.', { when: [{ tool: '^Bash$', cmd: 'npm test' }] });
  put('core-agent-rule', 'Правило ядра с триггером на Agent.', { when: [{ tool: '^Agent$' }] });
  put('core-once-bash', 'Класс одного раза с триггером на Bash.', { kind: 'once', when: [{ tool: '^Bash$', cmd: 'sudo' }] });
  put('core-knowledge', 'Знание ядра без триггера.', { kind: 'knowledge' });
  return mem;
}
// The lesson hook's config of its own (event and matcher), so a wider real matcher breaks nothing here.
function plugin(matcher = 'Bash|Edit|Write|MultiEdit|NotebookEdit') {
  const root = tmp('gc-plugin-');
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.mkdirSync(path.join(root, 'mechanisms'));
  fs.writeFileSync(path.join(root, 'mechanisms', 'memory-lessons.json'), JSON.stringify({ id: 'memory-lessons', event: 'PostToolUse' }));
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher, hooks: [] }] } }));
  return root;
}
const statusOf = (mem, id) => fs.readFileSync(path.join(mem, 'lessons', `${id}.md`), 'utf8').match(/^status: (\w+)/m)[1];

test('core: names the core lessons with a working trigger and why; changes nothing without --apply', () => {
  const mem = coreMemory();
  const r = run(['--memory', mem, '--plugin', plugin(), 'core']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /PostToolUse/);
  assert.match(r.out, /- core-bash-rule: [^\n]*when\[0\][^\n]*Bash/);
  assert.doesNotMatch(r.out, /core-agent-rule:|core-once-bash:|core-knowledge:/);
  assert.match(r.out, /--apply/);
  assert.strictEqual(statusOf(mem, 'core-bash-rule'), 'core');
  assert.strictEqual(readEvents(mem).events.length, 0);
});

test('core --apply <id>: only a named candidate goes to active, with an event; anything else refused, nothing changed', () => {
  const mem = coreMemory();
  const p = plugin();
  const no = run(['--memory', mem, '--plugin', p, 'core', '--apply', 'core-bash-rule', 'core-once-bash']);
  assert.strictEqual(no.code, 1);
  assert.match(no.err, /core-once-bash/);
  assert.strictEqual(statusOf(mem, 'core-bash-rule'), 'core', 'one bad id — nothing moved');
  assert.strictEqual(run(['--memory', mem, '--plugin', p, 'core', '--apply']).code, 2, '--apply without ids');
  const ok = run(['--memory', mem, '--plugin', p, 'core', '--apply', 'core-bash-rule', '--note', 'решение (г)']);
  assert.strictEqual(ok.code, 0, ok.err);
  assert.match(ok.out, /core-bash-rule/);
  assert.strictEqual(statusOf(mem, 'core-bash-rule'), 'active');
  const ev = readEvents(mem).events;
  assert.deepStrictEqual(ev.map((e) => [e.kind, e.lesson, e.note]), [['to-active', 'core-bash-rule', 'решение (г)']]);
  assert.match(run(['--memory', mem, '--plugin', p, 'core']).out, /кандидатов нет/i);
});

test('core: the matcher decides — the hook listening to Agent makes the Agent rule a candidate', () => {
  const mem = coreMemory();
  const r = run(['--memory', mem, '--plugin', plugin('Bash|Agent'), 'core']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /- core-agent-rule: /);
  assert.match(r.out, /- core-bash-rule: /);
  assert.doesNotMatch(r.out, /core-once-bash:/);
});

test('core: the hook config cannot be read — said so, nothing proposed, code 1', () => {
  const mem = coreMemory();
  const r = run(['--memory', mem, '--plugin', tmp('gc-noplugin-'), 'core']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /hooks\.json|memory-lessons/);
});

test('core --keep <id>: a candidate the user keeps in the core is not proposed again; the event survives fold; keep+apply — usage', () => {
  const mem = coreMemory();
  const p = plugin();
  assert.strictEqual(run(['--memory', mem, '--plugin', p, 'core', '--keep', 'core-once-bash']).code, 1, 'not a candidate');
  assert.strictEqual(run(['--memory', mem, '--plugin', p, 'core', '--keep', 'core-bash-rule', '--apply']).code, 2);
  assert.strictEqual(run(['--memory', mem, '--plugin', p, 'core', '--keep']).code, 2, '--keep without ids');
  const r = run(['--memory', mem, '--plugin', p, 'core', '--keep', 'core-bash-rule', '--note', 'стенд через MCP']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /core-bash-rule/);
  assert.strictEqual(statusOf(mem, 'core-bash-rule'), 'core');
  assert.match(run(['--memory', mem, '--plugin', p, 'core']).out, /кандидатов нет/i);
  // Months later the event month is folded: the decision stays.
  const ev = readEvents(mem).events.find((e) => e.kind === 'kept-core');
  const month = path.join(mem, 'events', fs.readdirSync(path.join(mem, 'events')).find((f) => f.endsWith('.jsonl')));
  fs.writeFileSync(month, `${JSON.stringify({ ...ev, at: '2026-01-10T00:00:00.000Z' })}\n`);
  fs.renameSync(month, path.join(mem, 'events', '2026-01.jsonl'));
  const f = run(['--memory', mem, 'fold', '--months', '3', '--now', '2026-11-06', '--apply']);
  assert.strictEqual(f.code, 0, f.err);
  assert.ok(readEvents(mem).events.some((e) => e.kind === 'kept-core' && e.lesson === 'core-bash-rule'));
  assert.match(run(['--memory', mem, '--plugin', p, 'core']).out, /кандидатов нет/i);
});
