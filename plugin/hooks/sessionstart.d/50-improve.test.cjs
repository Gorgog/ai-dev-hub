// node --test plugin/hooks/sessionstart.d/50-improve.test.cjs
// improve: when a session start runs the weekly cycle, shows its finished week once, says once that a run left no
// report, and stays silent otherwise — decide() over the state, the report and the clock.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { decide } = require('./50-improve.cjs');

const NOW = Date.parse('2026-11-05T10:00:00Z');
const H = 3600e3, D = 24 * H;
const at = (ms) => new Date(ms).toISOString();
const dead = 2 ** 22 + 12345; // a pid above the default pid_max: no such process
const live = process.pid;

test('нет ни одного запуска — запустить', () => {
  assert.strictEqual(decide(null, null, NOW), 'run');
  assert.strictEqual(decide({}, null, NOW), 'run');
});

test('идёт прогон — молчать, даже если прошлый итог не показан', () => {
  assert.strictEqual(decide({ started_at: at(NOW - H), pid: live }, null, NOW), null);
  assert.strictEqual(decide({ started_at: at(NOW - H), pid: live }, { summary: 'старый', mtime: NOW - 8 * D }, NOW), null);
});

test('прогон дописал итог — показать один раз, дальше молчать до следующей недели', () => {
  const st = { started_at: at(NOW - 2 * H), pid: dead };
  const rep = { summary: 'Недельный итог', mtime: NOW - H };
  assert.strictEqual(decide(st, rep, NOW), 'show');
  assert.strictEqual(decide({ ...st, pid: null, shown: rep.mtime }, rep, NOW), null);
  assert.strictEqual(decide({ ...st, pid: null, shown: rep.mtime }, rep, NOW - 2 * H + 7 * D), 'run');
});

test('итог дописан, а процесс ещё жив (pid переиспользован) — итог свежий, показать', () => {
  assert.strictEqual(decide({ started_at: at(NOW - 2 * H), pid: live }, { summary: 'x', mtime: NOW - H }, NOW), 'show');
});

test('прогон кончился без итога — сказать один раз; через неделю — новый запуск', () => {
  const st = { started_at: at(NOW - 2 * H), pid: dead };
  assert.strictEqual(decide(st, null, NOW), 'failed');
  assert.strictEqual(decide(st, { summary: 'прошлая неделя', mtime: NOW - 8 * D }, NOW), 'failed');
  assert.strictEqual(decide({ ...st, failed: st.started_at }, null, NOW), null);
  assert.strictEqual(decide({ ...st, failed: st.started_at }, null, NOW - 2 * H + 7 * D), 'run');
  // a run that hangs past 6 h is over too
  assert.strictEqual(decide({ started_at: at(NOW - 7 * H), pid: live }, null, NOW), 'failed');
});
