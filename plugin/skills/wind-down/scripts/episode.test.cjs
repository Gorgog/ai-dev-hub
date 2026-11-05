// node --test plugin/skills/wind-down/scripts/episode.test.cjs — wind-down's episode writer over memory v2
// (plugin/lib/memory/store.cjs): a new episode, a repeat, the class «once», the double write into the v1 errors.md,
// and a project of the old format left as it is.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { formatLesson, parseLesson } = require('../../../lib/memory/format.cjs');
const { readEvents } = require('../../../lib/memory/events.cjs');

const CLI = path.join(__dirname, 'episode.cjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const doc = (id, lines, more = {}) => formatLesson({ id, kind: more.kind || 'knowledge', when: more.when || [], keys: more.keys || [],
  status: more.status || 'active', supersedes: [], source: more.source || 'модель', created: more.created || '2026-11-05' }, lines);

const V1_HEAD = '# Правила из ошибок\n\n<!-- формат v1 -->\n- (2026-10-01, K-1) **Старое.** Запись v1. стоило: ~5 мин · повторов: 0 · механизм: нет · Ключи: `x`\n';

function sandbox({ v2 = true } = {}) {
  const root = tmp('episode-');
  const mem = path.join(root, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'errors.md'), V1_HEAD);
  if (v2) {
    fs.mkdirSync(path.join(mem, 'lessons'));
    fs.writeFileSync(path.join(mem, 'lessons', 'vitest-from-package.md'), doc('vitest-from-package',
      ['Тесты vitest в apps/web запускаются только из папки apps/web.', 'Из корня раннер падает с «No test files found».'],
      { keys: ['vitest', 'apps/web'] }));
  }
  const draft = (id, lines, more) => {
    const f = path.join(root, `${id}.draft.md`);
    fs.writeFileSync(f, doc(id, lines, more));
    return f;
  };
  return { root, mem, draft };
}
const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const v1Lines = (mem) => fs.readFileSync(path.join(mem, 'errors.md'), 'utf8').slice(V1_HEAD.length).split('\n').filter(Boolean);

test('a new episode: lesson file in v2 and one v1 line in errors.md, the same text and id (double write)', () => {
  const { mem, draft } = sandbox();
  const f = draft('dev-port-3000', ['Дев-сервер apps/web слушает порт 3000 — проверка на localhost:3000.',
    'Другой порт — значит, запущен не тот сервер; потеряли 15 минут.'], { keys: ['порт', 'дев-сервер'] });
  const r = run(['--memory', mem, 'add', f]);
  assert.strictEqual(r.code, 0, r.err);
  const lesson = fs.readFileSync(path.join(mem, 'lessons', 'dev-port-3000.md'), 'utf8');
  assert.strictEqual(lesson, fs.readFileSync(f, 'utf8'), 'the lesson is the draft byte for byte');
  const added = v1Lines(mem);
  assert.strictEqual(added.length, 1, added.join('\n'));
  const { body } = parseLesson(lesson);
  // The same meaning: the v1 line carries every body line of the lesson, its date and its id.
  assert.strictEqual(added[0], `- ${body.join(' ')} (2026-11-05, урок dev-port-3000)`);
  assert.ok(fs.readFileSync(path.join(mem, 'errors.md'), 'utf8').startsWith(V1_HEAD), 'v1 records before it are kept');
  assert.match(r.out, /эпизод dev-port-3000 записан/);
});

test('a draft close to a lesson already there is not written: named as a repeat candidate, nothing changes', () => {
  const { mem, draft } = sandbox();
  const before = fs.readFileSync(path.join(mem, 'errors.md'), 'utf8');
  const f = draft('vitest-root-fails', ['Vitest из корня репозитория не находит тесты apps/web — запускать из apps/web.',
    'Раннер пишет «No test files found».'], { keys: ['vitest', 'apps/web'] });
  const r = run(['--memory', mem, 'add', f]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.err, /похож.*vitest-from-package/s);
  assert.match(r.err, /repeat vitest-from-package/);
  assert.ok(!fs.existsSync(path.join(mem, 'lessons', 'vitest-root-fails.md')));
  assert.strictEqual(fs.readFileSync(path.join(mem, 'errors.md'), 'utf8'), before);
  // --new: the agent read both and says they are different things.
  assert.strictEqual(run(['--memory', mem, 'add', f, '--new']).code, 0);
  assert.ok(fs.existsSync(path.join(mem, 'lessons', 'vitest-root-fails.md')));
});

test('a repeat: event in v2, a v1 line naming the repeat; the 2nd episode of a knowledge lesson asks for a rule', () => {
  const { mem } = sandbox();
  const r = run(['--memory', mem, 'repeat', 'vitest-from-package', '--note', 'снова запустили из корня']);
  assert.strictEqual(r.code, 0, r.err);
  const ev = readEvents(mem).events;
  assert.deepStrictEqual(ev.map((e) => [e.kind, e.lesson, e.note]), [['repeat', 'vitest-from-package', 'снова запустили из корня']]);
  const added = v1Lines(mem);
  assert.strictEqual(added.length, 1);
  assert.match(added[0], /^- Повтор: снова запустили из корня\. Тесты vitest в apps\/web запускаются только из папки apps\/web\. \(\d{4}-\d\d-\d\d, урок vitest-from-package, повтор\)$/);
  assert.match(r.out, /2-й эпизод/);
  assert.match(r.out, /kind: rule/);
  assert.match(r.out, /механизм/);
});

test('class «once»: written at once as a lesson, said to be a mechanism; a rule draft without repeat or «once» is refused', () => {
  const { mem, draft } = sandbox();
  const f = draft('no-prod-db', ['Боевую базу не трогать из тестов: только тестовая БД рабочей копии.',
    'Сессия чуть не стёрла данные стенда.'], { kind: 'once', status: 'core', keys: ['база', 'данные'], source: 'пользователь' });
  const r = run(['--memory', mem, 'add', f]);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /класс «одного раза»/);
  assert.strictEqual(v1Lines(mem).length, 1);

  const g = draft('lint-own-files', ['Линтер — только по своим файлам ветки.', 'По всему каталогу он переписал чужие файлы.'],
    { kind: 'rule', keys: ['линтер'] });
  const refused = run(['--memory', mem, 'add', g]);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /правило — по повтору/);
  assert.ok(!fs.existsSync(path.join(mem, 'lessons', 'lint-own-files.md')));
  assert.strictEqual(run(['--memory', mem, 'add', g, '--user-said']).code, 0, 'по слову пользователя — сразу правило');
});

test('a draft the validator refuses: problems named, nothing written anywhere', () => {
  const { mem, draft } = sandbox();
  const before = fs.readFileSync(path.join(mem, 'errors.md'), 'utf8');
  const f = draft('bad-one', ['Одна строка.']);
  const r = run(['--memory', mem, 'add', f]);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /bad-one/);
  assert.ok(!fs.existsSync(path.join(mem, 'lessons', 'bad-one.md')));
  assert.strictEqual(fs.readFileSync(path.join(mem, 'errors.md'), 'utf8'), before);
});

test('a project of the old format: said so with the v1 way, code 0, no lessons/ and no events created', () => {
  const { mem, draft } = sandbox({ v2: false });
  const f = draft('dev-port-3000', ['Дев-сервер слушает порт 3000.', 'Другой порт — не тот сервер.']);
  for (const args of [['add', f], ['repeat', 'x']]) {
    const r = run(['--memory', mem, ...args]);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /памяти нового формата нет/);
    assert.match(r.out, /errors\.md/);
  }
  assert.deepStrictEqual(fs.readdirSync(mem), ['errors.md']);
  assert.strictEqual(fs.readFileSync(path.join(mem, 'errors.md'), 'utf8'), V1_HEAD);
});

test('a new episode below the similarity bar still names its nearest lessons: the agent checks for a repeat in other words', () => {
  const { mem, draft } = sandbox();
  const f = draft('npx-vitest-monorepo', ['Npx vitest run в корне монорепо не нашёл ни одного теста.', 'Перед прогоном — cd в пакет.'],
    { keys: ['тесты', 'монорепо'] });
  const r = run(['--memory', mem, 'add', f]);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /ближайшие уроки.*vitest-from-package/s);
  assert.match(r.out, /episode\.cjs repeat/);
});

test('repeat: a note over several lines stays one v1 record line', () => {
  const { mem } = sandbox();
  assert.strictEqual(run(['--memory', mem, 'repeat', 'vitest-from-package', '--note', 'строка1\nстрока2\r\n  строка3']).code, 0);
  const added = v1Lines(mem);
  assert.strictEqual(added.length, 1, added.join('\n'));
  assert.match(added[0], /^- Повтор: строка1 строка2 строка3\. Тесты vitest/);
});

test('repeat: the hint names the episode number — 2nd, then 3rd — while the lesson is still knowledge', () => {
  const { mem } = sandbox();
  assert.match(run(['--memory', mem, 'repeat', 'vitest-from-package', '--note', 'раз']).out, /2-й эпизод/);
  const r = run(['--memory', mem, 'repeat', 'vitest-from-package', '--note', 'два']).out;
  assert.match(r, /3-й эпизод/);
  assert.doesNotMatch(r, /2-й эпизод/);
});
