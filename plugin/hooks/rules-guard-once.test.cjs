// node --test plugin/hooks/rules-guard-once.test.cjs
// rules-guard, mode deny-once (slice 24, the ladder log → deny-once → deny of the weekly cycle): a known mode, no
// warning; the first hit in an epoch is a deny with the rule's text, the next ones pass — the spine keeps the key
// (`once`, lib/deliver.cjs); without the delivery the deny becomes the rule's text and the call passes.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRules, evaluate } = require('./rules-guard.cjs');
const guard = require('./pretool.d/20-rules-guard.cjs');

function project(t, rules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-once-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(rules));
  return dir;
}
const BASE = path.join(__dirname, 'base-rules.json');
const RULES = { rules: [
  { id: 'demo-rm', tools: '^Bash$', commands: '\\brm\\s+-rf\\b', text: 'rm -rf — только по списку путей' },
  { id: 'demo-ask', tools: '^Bash$', commands: '\\bdanger\\b', mode: 'ask', text: 'спросить' },
], modes: { 'demo-rm': 'deny-once' } };
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('deny-once — известный режим: без предупреждения, решение deny-once', (t) => {
  const dir = project(t, RULES);
  const { rules, warnings } = loadRules(BASE, dir);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(rules.find((r) => r.id === 'demo-rm').mode, 'deny-once');
  assert.strictEqual(evaluate(bash('rm -rf build'), rules).decision, 'deny-once');
  // ask is a gate for the user: it stays above a deny that passes after its first time
  assert.strictEqual(evaluate(bash('rm -rf build; danger'), rules).decision, 'ask');
});

test('модуль: deny с ключом once правила и его текстом; не сработало — молчит', (t) => {
  const dir = project(t, RULES);
  const res = guard.run(bash('rm -rf build'), { project: { dir }, version: 'x' });
  assert.strictEqual(res.decision, 'deny');
  assert.strictEqual(res.once, 'rules-guard:demo-rm');
  assert.match(res.reason, /demo-rm: rm -rf — только по списку путей/);
  assert.strictEqual(guard.run(bash('ls'), { project: { dir }, version: 'x' }), null);
});

test('deny-once рядом с log: в ключе — только правила deny-once, напоминание log — в причине', (t) => {
  const dir = project(t, { ...RULES, modes: { 'demo-rm': 'deny-once' } });
  const res = guard.run(bash('rm -rf build && sed -i s/a/b/ f'), { project: { dir }, version: 'x' });
  assert.strictEqual(res.once, 'rules-guard:demo-rm');
  assert.match(res.reason, /sed-in-place/);
});

test('несколько правил deny-once: ключ — одно правило (первое по id), напоминания и остальные — элементами', (t) => {
  const dir = project(t, { rules: [
    { id: 'ra', tools: '^Bash$', commands: '\\baaa\\b', text: 'про aaa' },
    { id: 'rb', tools: '^Bash$', commands: '\\bbbb\\b', text: 'про bbb' },
    { id: 'rl', tools: '^Bash$', commands: '\\blll\\b', text: 'про lll' },
  ], modes: { ra: 'deny-once', rb: 'deny-once' } });
  const ctx = { project: { dir }, version: 'x' };
  // the same rule keeps one key, whatever fires with it: its deny is once an epoch
  assert.strictEqual(guard.run(bash('aaa bbb'), ctx).once, 'rules-guard:ra');
  assert.strictEqual(guard.run(bash('aaa'), ctx).once, 'rules-guard:ra');
  assert.strictEqual(guard.run(bash('bbb'), ctx).once, 'rules-guard:rb');
  // when the deny is dropped (used in this epoch), the log reminder still reaches Claude
  const res = guard.run(bash('aaa lll'), ctx);
  assert.ok((res.items || []).some((it) => /rl: про lll/.test(it.text)), JSON.stringify(res.items));
});
