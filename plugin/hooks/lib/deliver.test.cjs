// node --test plugin/hooks/lib/deliver.test.cjs
// The delivery core as a pure step over the state of one agent in one epoch: limits per call and per epoch, priority
// block > lesson > reminder (the phase reminder in its own slot), «already shown», deny-once and the «prevented»
// measure over a window of the next calls.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { step, LIMITS, FRAME } = require('./deliver.cjs');
const { freshAgent } = require('./session.cjs');

const lesson = (id, extra = {}) => ({ text: `урок ${id}`, priority: 'lesson', key: id, lesson: id, ...extra });
const reminder = (id, extra = {}) => ({ text: `напоминание ${id}`, priority: 'reminder', key: id, ...extra });
const call = (agent, toolUseId, items = [], extra = {}) => step(agent, { items, toolUseId, final: null, fired: [], reaches: () => true, ...extra });
const kinds = (events) => events.map((e) => `${e.kind}:${e.lesson || e.key || e.rule || ''}`);

test('deliver: one lesson in one epoch — one show; a new epoch (compaction) or another agent shows it again', () => {
  const a = freshAgent(1);
  assert.match(call(a, 't1', [lesson('L1')]).text, /урок L1/);
  assert.strictEqual(call(a, 't2', [lesson('L1')]).text, '', 'the same epoch: already shown');
  assert.strictEqual(call(a, 't3', [lesson('L1', { text: 'урок L1, другими словами' })]).text, '', 'identity is the lesson id, not the text');
  assert.match(call(freshAgent(2), 't4', [lesson('L1')]).text, /урок L1/, 'after compaction — again');
  assert.match(call(freshAgent(1), 't5', [lesson('L1')]).text, /урок L1/, 'a subagent keeps its own marks');
});

test('deliver: a reminder without a lesson id is the same when its key and its text are the same', () => {
  const a = freshAgent(1);
  assert.match(call(a, 't1', [reminder('rules-guard', { text: 'правило cd' })]).text, /правило cd/);
  assert.match(call(a, 't2', [reminder('rules-guard', { text: 'правило add' })]).text, /правило add/, 'another rule under the same module key');
  assert.strictEqual(call(a, 't3', [reminder('rules-guard', { text: 'правило cd' })]).text, '');
});

test('deliver: on overflow of a call the lowest priority goes; a block is never pushed out, the phase has its own slot', () => {
  const a = freshAgent(1);
  const items = [
    reminder('r1'), reminder('r2'), { text: 'фаза 1', priority: 'phase', key: 'p1' }, lesson('L1'), reminder('r3'),
    { text: 'фаза 2', priority: 'phase', key: 'p2' }, lesson('L2'), { text: 'БЛОК', priority: 'block', key: 'b' }, reminder('r4'),
  ];
  const r = call(a, 't1', items);
  const lines = r.text.split('\n').filter((l) => !l.startsWith('[') && l);
  assert.deepStrictEqual(lines, ['БЛОК', 'урок L1', 'урок L2', 'напоминание r1', 'фаза 1'], r.text);
  assert.strictEqual(LIMITS.call, 3);
  const dropped = r.events.filter((e) => e.kind === 'dropped').map((e) => `${e.key}:${e.reason}`);
  assert.deepStrictEqual(dropped, ['r2:call', 'r3:call', 'r4:call', 'p2:phase']);
});

test('deliver: on overflow of the epoch a lesson wins over a reminder, a block passes always', () => {
  const a = freshAgent(1);
  a.count = LIMITS.epoch - 1;
  const r = call(a, 't1', [reminder('r1'), lesson('L1'), { text: 'БЛОК', priority: 'block', key: 'b' }]);
  assert.match(r.text, /урок L1/);
  assert.doesNotMatch(r.text, /напоминание r1/);
  assert.match(r.text, /БЛОК/);
  assert.deepStrictEqual(r.events.filter((e) => e.kind === 'dropped').map((e) => `${e.key}:${e.reason}`), ['r1:epoch']);
  const again = call(a, 't2', [{ text: 'БЛОК', priority: 'block', key: 'b' }, reminder('r2')]);
  assert.strictEqual(again.text, 'БЛОК', 'a block repeats, the epoch is full for the rest');
});

test('deliver: one item per key inside a call (the contract of 08), info is not counted in the limits', () => {
  const a = freshAgent(1);
  const r = call(a, 't1', [reminder('k', { text: 'первое' }), reminder('k', { text: 'второе' }),
    { text: 'бриф', priority: 'info', key: 'brief' }, lesson('L1'), lesson('L2'), lesson('L3')]);
  assert.doesNotMatch(r.text, /второе/);
  assert.match(r.text, /бриф/);
  assert.strictEqual(a.count, 3, 'the info item is not counted');
});

test('deliver: everything from memory is framed as data, not instructions', () => {
  const r = call(freshAgent(1), 't1', [lesson('L1'), reminder('r1'), { text: 'заметка', priority: 'info', key: 'n', source: 'memory' }]);
  const framed = (s) => r.text.includes(`${FRAME.open}\n${s}\n${FRAME.close}`);
  assert.ok(framed('урок L1'), r.text);
  assert.ok(framed('заметка'), r.text);
  assert.ok(!framed('напоминание r1'), 'a reminder of the hub itself is not memory');
  assert.match(FRAME.open, /данные из памяти/i);
  assert.match(FRAME.open, /не инструкции/i);
});

test('deliver: every shown item is an event, a deny is an event too', () => {
  const a = freshAgent(1);
  const r = call(a, 't1', [lesson('L1'), reminder('r1', { module: 'rules-guard' })]);
  assert.deepStrictEqual(kinds(r.events), ['shown:L1', 'shown:r1']);
  assert.strictEqual(r.events[1].rule, 'rules-guard', 'without a lesson id the rule is the module');
  const d = call(a, 't2', [], { final: { decision: 'deny', reason: 'нельзя', module: 'lock' } });
  assert.deepStrictEqual(kinds(d.events), ['deny:lock']);
});

test('deliver: items that cannot reach Claude (a deny on PreToolUse) are not marked shown', () => {
  const a = freshAgent(1);
  const r = call(a, 't1', [lesson('L1')], { final: { decision: 'deny', reason: 'стоп', module: 'lock' }, reaches: () => false });
  assert.strictEqual(r.text, '');
  assert.match(call(a, 't2', [lesson('L1')]).text, /урок L1/, 'shown on the next call');
});

test('deliver: deny-once — the first deny with a key stands, the next one in the epoch is dropped', () => {
  const a = freshAgent(1);
  const deny = { decision: 'deny', reason: 'урок L1: так нельзя', once: 'L1', lesson: 'L1', module: 'lessons' };
  assert.strictEqual(call(a, 't1', [], { final: { ...deny } }).final.decision, 'deny');
  assert.ok(a.once.L1, 'the key is marked in the epoch');
  const again = call(a, 't2', [], { final: { ...deny } });
  assert.strictEqual(again.final, null, 'the repeat passes');
  assert.strictEqual(call(freshAgent(2), 't3', [], { final: { ...deny } }).final.decision, 'deny', 'a new epoch denies once more');
});

test('deliver: «prevented» on a synthetic sequence — the answer is known', () => {
  const a = freshAgent(1);
  const ev = [];
  const go = (t, items = [], extra = {}) => ev.push(...call(a, t, items, extra).events);
  const L = (id, d) => lesson(id, { detector: d });
  go('t1', [L('L1', 'D1')]); // shown, window opens
  go('t2');
  go('t3', [L('L1', 'D1')]); // D1 again on the 2nd call after — repeat in the window, not shown again
  go('t4', [L('L2', 'D2')]); // shown
  go('t4', [L('L2', 'D2')]); // the same call (PostToolUse of t4) — not a repeat
  go('t5'); go('t6'); go('t7');
  go('t8', [L('L2', 'D2')]); // the 4th call: the window of D2 closed at the start of t8 — prevented, then a late repeat
  go('t9', [lesson('L3')]); // no detector: not measured
  go('t10', [L('L4', 'D4')]);
  go('t11');
  // A deny-once with the lesson and a detector opens a window too; its repeat arrives as a fired detector.
  go('t12', [], { final: { decision: 'deny', reason: 'урок L5', once: 'L5', lesson: 'L5', detector: 'D5', module: 'lessons' } });
  go('t13', [], { fired: [{ detector: 'D5', lesson: 'L5' }] });
  const out = ev.filter((e) => e.kind !== 'shown' && e.kind !== 'deny').map((e) => `${e.kind}:${e.lesson}:${e.calls}${e.kind === 'repeat' ? `:${e.window}` : ''}`);
  assert.deepStrictEqual(out, ['repeat:L1:2:true', 'prevented:L2:3', 'repeat:L2:4:false', 'repeat:L5:1:true']);
  assert.deepStrictEqual(a.pending.map((p) => p.lesson), ['L4'], 'L4 is still open: 1 call of 3');
  assert.strictEqual(LIMITS.window, 3);
});
