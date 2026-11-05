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

test('review: no model ever recorded in the events — nothing to compare, nothing marked', () => {
  const mem = memory();
  const r = run(['--memory', mem, 'review', '--model', 'model-b']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /модель прошлых событий неизвестна/);
  assert.strictEqual(readEvents(mem).events.length, 0);
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
