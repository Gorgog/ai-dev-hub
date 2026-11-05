// node --test plugin/hooks/lib/session.test.cjs
// The state file of a session: the epoch of every agent (P16: startup | clear | compact → +1, resume — the same,
// a subagent — its own), the model of the session, updates under a lock, a broken file read as a fresh one.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const session = require('./session.cjs');

const made = [];
const mkdtemp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const start = (dir, source, extra = {}) => session.startEpoch({ hook_event_name: 'SessionStart', session_id: 's1', source, ...extra }, dir);
const epochOf = (dir, agent = 'main') => session.read('s1', dir).agents[agent].epoch;

test('session: epochs follow P16 — startup, compact and clear open one, resume keeps it, a subagent has its own', () => {
  const dir = mkdtemp();
  start(dir, 'startup', { model: 'claude-test' });
  assert.strictEqual(epochOf(dir), 1);
  assert.strictEqual(session.read('s1', dir).model, 'claude-test');
  start(dir, 'resume');
  assert.strictEqual(epochOf(dir), 1);
  start(dir, 'compact');
  assert.strictEqual(epochOf(dir), 2);
  start(dir, 'clear');
  assert.strictEqual(epochOf(dir), 3);
  session.startEpoch({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1' }, dir);
  assert.strictEqual(epochOf(dir, 'a1'), 1);
  assert.strictEqual(epochOf(dir), 3, 'the main thread is untouched');
  start(dir, 'resume');
  assert.strictEqual(epochOf(dir), 3);
  assert.strictEqual(session.read('s1', dir).model, 'claude-test', 'a start without a model keeps the known one');
  session.startEpoch({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1' }, dir);
  assert.strictEqual(epochOf(dir, 'a1'), 1, 'a continued subagent keeps its context, so its epoch');
});

test('session: a resume of an unknown session opens epoch 1; a new epoch resets the marks and expires open windows', () => {
  const dir = mkdtemp();
  start(dir, 'resume');
  assert.strictEqual(epochOf(dir), 1);
  session.update('s1', (st) => {
    const a = st.agents.main;
    a.shown.L1 = 1;
    a.calls = 5;
    a.pending.push({ detector: 'D1', lesson: 'L1', at: 't4', n: 4 });
  }, dir);
  const { expired } = start(dir, 'compact');
  assert.deepStrictEqual(expired.map((e) => [e.kind, e.lesson, e.calls, e.epoch]), [['expired', 'L1', 1, 1]]);
  const a = session.read('s1', dir).agents.main;
  assert.deepStrictEqual([a.epoch, a.shown, a.pending, a.counts], [2, {}, [], { lesson: 0, reminder: 0 }]);
});

test('session: a broken state file is read as a fresh one and rewritten', () => {
  const dir = mkdtemp();
  start(dir, 'startup');
  fs.writeFileSync(session.file('s1', dir), '{"agents": {"main": ');
  assert.deepStrictEqual(session.read('s1', dir).agents, {});
  start(dir, 'startup');
  assert.strictEqual(epochOf(dir), 1);
});

test('session: a session id cannot leave the folder of states', () => {
  const dir = mkdtemp();
  assert.strictEqual(path.dirname(session.file('../../etc/x', dir)), path.join(dir, 'sessions'));
});

test('session: 7 processes updating one state under the lock lose nothing', async () => {
  const dir = mkdtemp();
  const worker = `const s = require(${JSON.stringify(require.resolve('./session.cjs'))});
    for (let i = 0; i < 40; i++) s.update('s1', (st) => { st.n = (st.n || 0) + 1; }, process.argv[1]);`;
  await Promise.all(Array.from({ length: 7 }, () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', worker, dir], { stdio: 'inherit' });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker: ${code}`))));
  })));
  assert.strictEqual(session.read('s1', dir).n, 280);
});

test('session: old state files are swept at a session start', () => {
  const dir = mkdtemp();
  start(dir, 'startup');
  const old = session.file('old', dir);
  fs.writeFileSync(old, '{}');
  const t = (Date.now() - 40 * 864e5) / 1000;
  fs.utimesSync(old, t, t);
  session.sweep(dir);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(session.file('s1', dir)));
});

test('session: a lock left by a hook killed a moment ago is waited out, not a reason to lose the update', () => {
  const dir = mkdtemp();
  start(dir, 'startup');
  const lock = `${session.file('s1', dir)}.lock`;
  fs.writeFileSync(lock, 'dead');
  const t = (Date.now() - 1400) / 1000;
  fs.utimesSync(lock, t, t);
  start(dir, 'compact');
  assert.strictEqual(epochOf(dir), 2);
});

test('session: a state of another schema version reads as a fresh one', () => {
  const dir = mkdtemp();
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(session.file('s1', dir), JSON.stringify({ v: 2, agents: { main: { epoch: 7 } } }));
  assert.deepStrictEqual(session.read('s1', dir).agents, {});
});

test('session: the owner removes only its own lock', () => {
  const dir = mkdtemp();
  start(dir, 'startup');
  const lock = `${session.file('s1', dir)}.lock`;
  session.update('s1', () => fs.writeFileSync(lock, 'someone-else'), dir);
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'someone-else', 'a lock taken over by another is not ours to remove');
});
