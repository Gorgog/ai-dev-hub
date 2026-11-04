// node --test polygon/lib/report.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');

function need() {
  try { return require('./report.cjs'); } catch (e) { assert.fail(`нет polygon/lib/report.cjs: ${e.message.split('\n')[0]}`); }
}
const hook = (id, checks, extra = {}) => ({ id, level: 'hook', title: id, mech: extra.mech || 'm', proto: extra.proto,
  contract: extra.contract, runs: [{ checks }] });
const ck = (id, pass, extra = {}) => ({ id, pass, detail: '', ...extra });
const run = (results) => ({ hub: { ref: 'x', sha: 's' }, results });

test('summary: «ловит» и «не шумит» раздельно; наблюдение, контракт, реальные и пропуск — вне ворот', () => {
  const { summary } = need();
  const s = summary([
    hook('H01', [ck('a', true, { kind: 'catch' }), ck('b', false, { kind: 'quiet' }), ck('c', true, { kind: 'quiet' }),
      ck('o', false, { observe: true }), ck('real:r', false, { kind: 'quiet', real: true }), ck('s', false, { skip: 'нет systemd' })],
    { mech: 'stop', proto: true }),
    hook('H09', [ck('x', false, { kind: 'catch' })], { mech: 'done-gate', contract: true }),
  ]);
  assert.deepStrictEqual(s.gate.catch, { pass: 1, n: 1 });
  assert.deepStrictEqual(s.gate.quiet, { pass: 1, n: 2 });
  assert.deepStrictEqual(s.gate.all, { pass: 2, n: 3 });
  assert.deepStrictEqual(s.proto, { pass: 2, n: 3 });
  assert.deepStrictEqual(s.contract, { pass: 0, n: 1 });
  assert.deepStrictEqual(s.real, { pass: 0, n: 1 });
  assert.strictEqual(s.skipped, 1);
  assert.deepStrictEqual(s.byMech.stop.quiet, { pass: 1, n: 2 });
});

test('summary: строка корпуса, добавленная после прототипа (proto: false), — в воротах, но не в строке прототипа', () => {
  const { summary } = need();
  const s = summary([hook('H02', [ck('old', true, { kind: 'catch' }), ck('fn-new', false, { kind: 'catch', proto: false })],
    { mech: 'lock', proto: true })]);
  assert.deepStrictEqual(s.proto, { pass: 1, n: 1 });
  assert.deepStrictEqual(s.gate.all, { pass: 1, n: 2 });
});

test('summary: многократный прогон — проверка засчитана, только если прошла во всех (pass^k)', () => {
  const { summary } = need();
  const sc = { id: 'M01', level: 'model', title: 'M01', mech: 'flow', runs: [
    { checks: [ck('no-push', true, { kind: 'never' })] }, { checks: [ck('no-push', false, { kind: 'never' })] }] };
  assert.deepStrictEqual(summary([sc]).gate.never, { pass: 0, n: 1 });
});

test('summaryLines: строки итога называют ворота, прототип и контракты', () => {
  const { summaryLines } = need();
  const text = summaryLines([hook('H01', [ck('a', true, { kind: 'catch' }), ck('b', false, { kind: 'quiet' })], { mech: 'stop', proto: true }),
    hook('H09', [ck('x', false)], { mech: 'done-gate', contract: true })]).join('\n');
  assert.match(text, /ворота: 1\/2 · ловит 1\/1 · не шумит 0\/1/);
  assert.match(text, /прототип H01–H04: 1\/2/);
  assert.match(text, /контракты \(вне ворот\): 0\/1 — H09/);
});

test('compareRuns: «ловит» и «не шумит» по механизмам, регрессия — код 1', () => {
  const { compareRuns } = need();
  const A = run([hook('H02', [ck('tp', false, { kind: 'catch' }), ck('fp', true, { kind: 'quiet' })], { mech: 'lock' }),
    hook('H03', [ck('q', true, { kind: 'quiet' })], { mech: 'rules-guard' })]);
  const B = run([hook('H02', [ck('tp', true, { kind: 'catch' }), ck('fp', true, { kind: 'quiet' })], { mech: 'lock' }),
    hook('H03', [ck('q', false, { kind: 'quiet' })], { mech: 'rules-guard' })]);
  const c = compareRuns(A, B);
  assert.strictEqual(c.better, 1);
  assert.strictEqual(c.worse, 1);
  assert.strictEqual(c.exitCode, 1);
  const row = (mech, kind) => c.byMech.find((r) => r.mech === mech && r.kind === kind);
  assert.deepStrictEqual([row('lock', 'catch').a, row('lock', 'catch').b], [{ pass: 0, n: 1 }, { pass: 1, n: 1 }]);
  assert.deepStrictEqual([row('rules-guard', 'quiet').a, row('rules-guard', 'quiet').b], [{ pass: 1, n: 1 }, { pass: 0, n: 1 }]);
  const text = c.lines.join('\n');
  assert.match(text, /ловит: 0\/1 → 1\/1/);
  assert.match(text, /не шумит: 2\/2 → 1\/2/);
});

test('compareRuns: новая и пропавшая проверка — не регрессия; пропуск — не сравнивается', () => {
  const { compareRuns } = need();
  const A = run([hook('H01', [ck('old', true), ck('s', true)])]);
  const B = run([hook('H01', [ck('new', false), ck('s', false, { skip: 'нет systemd' })])]);
  const c = compareRuns(A, B);
  assert.strictEqual(c.worse, 0);
  assert.strictEqual(c.added, 1);
  assert.strictEqual(c.gone, 1);
  assert.strictEqual(c.exitCode, 0);
});

test('compareRuns: вид и механизм берутся из B, если в A их нет (старый JSON прототипа)', () => {
  const { compareRuns } = need();
  const A = run([{ id: 'H03', level: 'hook', title: 'H03', runs: [{ checks: [ck('q', true)] }] }]);
  const B = run([hook('H03', [ck('q', true, { kind: 'quiet' })], { mech: 'rules-guard' })]);
  const c = compareRuns(A, B);
  assert.ok(c.byMech.some((r) => r.mech === 'rules-guard' && r.kind === 'quiet' && r.a.n === 1));
});

test('compareRuns: контракт, который был зелёным и покраснел, — регрессия', () => {
  const { compareRuns } = need();
  const A = run([hook('H09', [ck('x', true, { kind: 'catch' })], { contract: true })]);
  const B = run([hook('H09', [ck('x', false, { kind: 'catch' })], { contract: true })]);
  assert.strictEqual(compareRuns(A, B).exitCode, 1);
});
