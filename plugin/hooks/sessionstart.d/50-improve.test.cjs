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

test('два старта разом: прогон запускает один — второй видит замок запуска', (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-lock-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const hub = path.join(base, 'hub');
  fs.mkdirSync(path.join(hub, 'projects', 'demo'), { recursive: true });
  const hd = path.join(base, 'hd');
  fs.mkdirSync(path.join(hd, 'analytics'), { recursive: true });
  fs.writeFileSync(path.join(hd, 'analytics', 'calls.db'), '');
  fs.mkdirSync(path.join(hd, 'hub', 'projects', 'demo'), { recursive: true });
  const fake = path.join(base, 'fake.py');
  fs.writeFileSync(fake, 'import sys\n');
  const data = path.join(base, 'data');
  const saved = { ...process.env };
  t.after(() => { for (const k of ['HUB_DATA', 'HUB_IMPROVE_WEEKLY', 'HUB_LOG_DIR', 'HUB_RUN_NO_SYSTEMD']) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  Object.assign(process.env, { HUB_DATA: hd, HUB_IMPROVE_WEEKLY: fake, HUB_LOG_DIR: data, HUB_RUN_NO_SYSTEMD: '1' });
  const mod = require('./50-improve.cjs');
  const lock = path.join(data, 'improve', 'start.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, 'other start');
  mod.run({ source: 'startup', cwd: hub }, { hub, stage: 'on' });
  assert.ok(!fs.existsSync(path.join(data, 'improve', 'state.json')), 'замок свежий — не запускать');
  const old = (Date.now() - 120e3) / 1000;
  fs.utimesSync(lock, old, old);
  mod.run({ source: 'startup', cwd: hub }, { hub, stage: 'on' });
  assert.ok(fs.existsSync(path.join(data, 'improve', 'state.json')), 'протухший замок не держит');
  assert.ok(!fs.existsSync(lock), 'замок снят после записи состояния');
});
