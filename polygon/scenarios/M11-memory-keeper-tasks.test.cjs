// node --test polygon/scenarios/M11-memory-keeper-tasks.test.cjs — грейдер теста памяти 5 на синтетике, без модели:
// правильное действие (как сделал бы агент: recall и Write/Edit) — зелёное; бездействие, порча, ошибка экранирования — красное.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const variants = require('./M11-memory-keeper-tasks.cjs');
const V = Object.fromEntries(variants.map((v) => [v.id, v]));
const ROOT = path.join(__dirname, '..', '..');

// A hub version with the plugin under test (the grader reads memory through its library) and the memory template.
function base() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-base-'));
  fs.cpSync(path.join(ROOT, 'plugin'), path.join(d, 'plugin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'templates'), path.join(d, 'templates'), { recursive: true });
  return d;
}
const work = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm11-work-'));
async function fixture(id) { return V[id].setup({ base: base(), work: work() }); }
const recall = (st, ...args) => {
  const r = spawnSync(process.execPath, [path.join(st.hubDir, 'plugin', 'skills', 'recall', 'scripts', 'recall.cjs'), '--memory', st.ctx.mem, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
};
const lessonFile = (st, id) => path.join(st.ctx.mem, 'lessons', `${id}.md`);
const edit = (st, id, from, to) => {
  const f = lessonFile(st, id);
  const t = fs.readFileSync(f, 'utf8');
  assert.ok(t.includes(from), `${id}: нет «${from}»`);
  fs.writeFileSync(f, t.replace(from, () => to));
};
const run = ({ errors = [] } = {}) => ({ turns: 4, costUsd: 0.2, events: [
  ...errors.map((text) => ({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: text }] } })),
  { type: 'result', usage: { input_tokens: 10, cache_read_input_tokens: 2000, output_tokens: 300 } }] });
const failed = (checks) => checks.filter((c) => !c.pass && !c.observe).map((c) => `${c.id}: ${c.detail}`);

const NEW = ['---', 'id: vitest-run-from-app', 'kind: rule', 'when: []', 'keys: [vitest, apps/web]', 'status: active', 'supersedes: []',
  'source: пользователь', 'created: 2026-11-05', '---', 'Тесты vitest в apps/web — только из папки apps/web: из корня «No test files found».',
  'Потеряли 20 минут.', ''].join('\n');

test('M11: шесть вариантов — по задаче на вариант, id M11-*', () => {
  assert.deepStrictEqual(variants.map((v) => v.id), ['M11-new', 'M11-repeat', 'M11-merge', 'M11-replace', 'M11-retire', 'M11-when']);
});

test('M11-new: новый валидный урок — зелёное; ничего не сделано — красное', async () => {
  const st = await fixture('M11-new');
  assert.ok(failed(await V['M11-new'].grade({ run: run(), ctx: st.ctx })).length > 0);
  fs.writeFileSync(lessonFile(st, 'vitest-run-from-app'), NEW);
  assert.deepStrictEqual(failed(await V['M11-new'].grade({ run: run(), ctx: st.ctx })), []);
});

test('M11-repeat: событие repeat того урока — зелёное; копия урока вместо события — красное', async () => {
  const st = await fixture('M11-repeat');
  recall(st, 'repeat', 'git-commit-msg-file');
  assert.deepStrictEqual(failed(await V['M11-repeat'].grade({ run: run(), ctx: st.ctx })), []);
  const st2 = await fixture('M11-repeat');
  fs.writeFileSync(lessonFile(st2, 'commit-again'), fs.readFileSync(lessonFile(st2, 'git-commit-msg-file'), 'utf8').replace(/git-commit-msg-file/, 'commit-again'));
  assert.ok(failed(await V['M11-repeat'].grade({ run: run(), ctx: st2.ctx })).some((f) => /repeat-event|no-new-lesson/.test(f)));
});

test('M11-merge: текст в приёмник + merge — зелёное; один статус руками без события — красное', async () => {
  const st = await fixture('M11-merge');
  edit(st, 'prisma-generate-after-checkout', 'Иначе тесты падают на старом клиенте: «Cannot read properties of undefined».',
    'Иначе тесты падают на старом клиенте: «Cannot read properties of undefined».\nСхема на ветке новее клиента в node_modules — фантомные падения.');
  recall(st, 'merge', 'prisma-client-stale', 'prisma-generate-after-checkout');
  assert.deepStrictEqual(failed(await V['M11-merge'].grade({ run: run(), ctx: st.ctx })), []);
  const st2 = await fixture('M11-merge');
  edit(st2, 'prisma-client-stale', 'status: active', 'status: superseded');
  assert.ok(failed(await V['M11-merge'].grade({ run: run(), ctx: st2.ctx })).some((f) => /merged-event|supersedes-set/.test(f)));
});

test('M11-replace: новый урок с supersedes + supersede — зелёное; правка старого на месте — красное', async () => {
  const st = await fixture('M11-replace');
  fs.writeFileSync(lessonFile(st, 'dev-port-5173'), ['---', 'id: dev-port-5173', 'kind: rule', 'when: []', 'keys: [порт, vite]', 'status: active',
    'supersedes: [dev-port-3000]', 'source: пользователь', 'created: 2026-11-05', '---',
    'Дев-сервер apps/web (vite) слушает порт 5173 — проверка в браузере на localhost:5173.', 'Порт 3000 — старый сервер.', ''].join('\n'));
  recall(st, 'supersede', 'dev-port-3000', 'dev-port-5173');
  assert.deepStrictEqual(failed(await V['M11-replace'].grade({ run: run(), ctx: st.ctx })), []);
  const st2 = await fixture('M11-replace');
  edit(st2, 'dev-port-3000', 'порт 3000 — проверка в браузере на localhost:3000', 'порт 5173 — проверка в браузере на localhost:5173');
  assert.ok(failed(await V['M11-replace'].grade({ run: run(), ctx: st2.ctx })).length > 0);
});

test('M11-retire: retire — зелёное; удалённый файл — красное', async () => {
  const st = await fixture('M11-retire');
  recall(st, 'retire', 'mailhog-check', '--note', 'убрали со стенда');
  assert.deepStrictEqual(failed(await V['M11-retire'].grade({ run: run(), ctx: st.ctx })), []);
  const st2 = await fixture('M11-retire');
  fs.rmSync(lessonFile(st2, 'mailhog-check'));
  assert.ok(failed(await V['M11-retire'].grade({ run: run(), ctx: st2.ctx })).some((f) => /kept-in-archive/.test(f)));
});

test('M11-when: регэксп ловит -w и --write, не --check — зелёное; ловит всё подряд — красное; битый — красное', async () => {
  const st = await fixture('M11-when');
  edit(st, 'prettier-write', 'cmd: prettier[^|;&]*--write', 'cmd: prettier[^|;&]*(--write|\\s-w\\b)');
  assert.deepStrictEqual(failed(await V['M11-when'].grade({ run: run(), ctx: st.ctx })), []);
  const st2 = await fixture('M11-when');
  edit(st2, 'prettier-write', 'cmd: prettier[^|;&]*--write', 'cmd: prettier');
  assert.ok(failed(await V['M11-when'].grade({ run: run(), ctx: st2.ctx })).some((f) => /when-quiet/.test(f)));
  const st3 = await fixture('M11-when');
  edit(st3, 'prettier-write', 'cmd: prettier[^|;&]*--write', 'cmd: prettier(--write');
  assert.ok(failed(await V['M11-when'].grade({ run: run(), ctx: st3.ctx })).some((f) => /when-compiles|memory-valid/.test(f)));
});

test('M11: ошибка экранирования в транскрипте — красное «никогда»; токены — в наблюдении; чужой урок тронут — красное', async () => {
  const st = await fixture('M11-retire');
  recall(st, 'retire', 'mailhog-check');
  const bad = await V['M11-retire'].grade({ run: run({ errors: ['/bin/bash: line 3: unexpected EOF while looking for matching `\'\''] }), ctx: st.ctx });
  assert.deepStrictEqual(failed(bad).map((f) => f.split(':')[0]), ['no-escaping-errors']);
  assert.match(bad.find((c) => c.id === 'tokens').detail, /токены 2310/);
  edit(st, 'no-env-edit', 'не читать вслух', 'не читать');
  assert.ok(failed(await V['M11-retire'].grade({ run: run(), ctx: st.ctx })).some((f) => /others-untouched/.test(f)));
});
