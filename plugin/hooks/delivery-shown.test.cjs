// node --test plugin/hooks/delivery-shown.test.cjs
// «Already shown» is marked only after the output reached stdout: a hook killed while its text is on the way leaves
// the lesson unshown in the epoch, the next call shows it again (better twice than never). The kill is staged, not
// raced: a preload replaces process.stdout.write of the runner with SIGKILL of its own process. The runner, lib/ and
// the delivery's records are this branch's, in a copy of the plugin with one synthetic lesson module.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOOKS = __dirname;
const PLUGIN = path.dirname(HOOKS);
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

const LESSON = `module.exports = { id: 'lesson', run(ev) {
  if (!/BAD/.test((ev.tool_input || {}).command || '')) return null;
  return { items: [{ text: 'урок L1: не делай BAD', priority: 'lesson', key: 'L1', lesson: 'L1', source: 'memory' }] };
} };\n`;
// The hook is killed at its first write to stdout: nothing reaches Claude.
const DIE_ON_WRITE = "process.stdout.write = function () { process.kill(process.pid, 'SIGKILL'); };\n";

function setup() {
  const hub = mkdtemp('delivery-shown-');
  const plugin = path.join(hub, 'plugin');
  fs.cpSync(path.join(HOOKS, 'run.cjs'), path.join(plugin, 'hooks', 'run.cjs'));
  fs.cpSync(path.join(HOOKS, 'lib'), path.join(plugin, 'hooks', 'lib'), { recursive: true });
  for (const f of fs.readdirSync(path.join(PLUGIN, 'mechanisms')).filter((n) => /^delivery/.test(n))) {
    const rec = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'mechanisms', f), 'utf8'));
    fs.cpSync(path.join(HOOKS, rec.file), path.join(plugin, 'hooks', rec.file));
    write(path.join(plugin, 'mechanisms', f), JSON.stringify(rec));
  }
  write(path.join(plugin, 'hooks', 'pretool.d', '10-lesson.cjs'), LESSON);
  write(path.join(plugin, 'mechanisms', 'lesson.json'), JSON.stringify({ id: 'lesson', event: 'PreToolUse', file: 'pretool.d/10-lesson.cjs',
    handler: 'lesson', stage: 'on', onError: 'open', failScope: 'any', state: [], reads: [], polygon: ['H62'], replaces: '—', review: '2099-01-01' }));
  const proj = path.join(hub, 'projects', 'demo');
  const wt = path.join(proj, 'worktrees', 'K-1');
  fs.mkdirSync(wt, { recursive: true });
  write(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['delivery'] }));
  const logs = mkdtemp('delivery-shown-logs-');
  const die = path.join(logs, 'die-on-write.cjs');
  fs.writeFileSync(die, DIE_ON_WRITE);
  return { hub, plugin, wt, logs, die };
}

const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HUB_|AI_DEV_HUB|CLAUDE_PLUGIN|NODE_OPTIONS)/.test(k)));
function run(s, event, ev, { preload } = {}) {
  const r = spawnSync(process.execPath, [...(preload ? ['-r', preload] : []), path.join(s.plugin, 'hooks', 'run.cjs'), event], {
    input: JSON.stringify({ hook_event_name: event, session_id: 's1', permission_mode: 'default', cwd: s.wt, ...ev }),
    encoding: 'utf8', timeout: 20000, env: { ...baseEnv(), AI_DEV_HUB: s.hub, HUB_LOG_DIR: s.logs, CLAUDE_PLUGIN_ROOT: s.plugin } });
  let json = null;
  try { json = r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null; } catch { /* plain text */ }
  return { signal: r.signal, out: r.stdout, ctx: json && json.hookSpecificOutput ? json.hookSpecificOutput.additionalContext || '' : '' };
}
const pre = (s, id, opts) => run(s, 'PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'echo BAD' } }, opts);

test('shown: a hook killed at its output leaves the lesson unshown, the next call shows it', () => {
  const s = setup();
  run(s, 'SessionStart', { source: 'startup' });
  const killed = pre(s, 't1', { preload: s.die });
  assert.strictEqual(killed.signal, 'SIGKILL', 'the staging killed the hook');
  assert.strictEqual(killed.out, '', 'nothing reached Claude');
  const next = pre(s, 't2');
  assert.match(next.ctx, /урок L1/, 'the lesson Claude never saw is shown on the next call');
  assert.doesNotMatch(pre(s, 't3').ctx, /урок L1/, 'once written, it is shown in the epoch');
});

test('shown: control — without the kill the lesson is shown once in the epoch', () => {
  const s = setup();
  run(s, 'SessionStart', { source: 'startup' });
  assert.match(pre(s, 't1').ctx, /урок L1/);
  assert.doesNotMatch(pre(s, 't2').ctx, /урок L1/, 'the staging tells «shown» from «not shown»');
});

test('shown: finish holds the mark back, confirm sets it in the epoch of the call only', () => {
  const before = process.env.HUB_LOG_DIR;
  process.env.HUB_LOG_DIR = mkdtemp('delivery-shown-lib-');
  try {
    const session = require('./lib/session.cjs');
    const D = require('./lib/deliver.cjs');
    const items = [{ text: 'урок L1', priority: 'lesson', key: 'L1', lesson: 'L1' }];
    const call = (sid) => D.open('PreToolUse', { session_id: sid, tool_use_id: 't1' }).finish({ items, final: null, reaches: () => true });
    session.startEpoch({ session_id: 'c1', source: 'startup' });
    const r = call('c1');
    assert.match(r.text, /урок L1/);
    const way = session.read('c1').agents.main.shown['lesson:L1'];
    assert.strictEqual(way && way.pid, process.pid, 'before the text is written the mark is only on its way');
    r.confirm();
    assert.deepStrictEqual(session.read('c1').agents.main.shown, { 'lesson:L1': 1 });
    // A compaction between the output and the mark: the new epoch never had the text.
    session.startEpoch({ session_id: 'c2', source: 'startup' });
    const r2 = call('c2');
    session.startEpoch({ session_id: 'c2', source: 'compact' });
    r2.confirm();
    const a = session.read('c2').agents.main;
    assert.deepStrictEqual([a.epoch, a.shown], [2, {}]);
  } finally { if (before === undefined) delete process.env.HUB_LOG_DIR; else process.env.HUB_LOG_DIR = before; }
});

// N hooks of one agent at once (parallel tool calls of one message): the lesson is shown by exactly one of them, as
// before slice 36 — the mark held back until the output must still be seen by the neighbours.
function runAsync(s, id) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(s.plugin, 'hooks', 'run.cjs'), 'PreToolUse'], {
      env: { ...baseEnv(), AI_DEV_HUB: s.hub, HUB_LOG_DIR: s.logs, CLAUDE_PLUGIN_ROOT: s.plugin } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out));
    p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', permission_mode: 'default', cwd: s.wt,
      tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'echo BAD' } }));
  });
}

test('shown: parallel calls of one agent show the lesson once', async () => {
  const counts = [];
  for (let trial = 0; trial < 6; trial++) {
    const s = setup();
    run(s, 'SessionStart', { source: 'startup' });
    const outs = await Promise.all([1, 2, 3, 4].map((i) => runAsync(s, `p${i}`)));
    counts.push(outs.filter((o) => /урок L1/.test(o)).length);
  }
  assert.deepStrictEqual(counts, [1, 1, 1, 1, 1, 1], 'how many of 4 parallel calls showed the lesson, per trial');
});

test('shown: a mark on its way hides the lesson while its owner lives and is fresh; dead or stale — shown again', () => {
  const before = process.env.HUB_LOG_DIR;
  process.env.HUB_LOG_DIR = mkdtemp('delivery-shown-way-');
  try {
    const session = require('./lib/session.cjs');
    const D = require('./lib/deliver.cjs');
    const items = [{ text: 'урок L1', priority: 'lesson', key: 'L1', lesson: 'L1' }];
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    const cases = { live: { pid: process.pid, at: Date.now() }, stale: { pid: process.pid, at: Date.now() - D.LIMITS.inFlightMs - 1000 },
      dead: { pid: Number(dead), at: Date.now() }, confirmed: 1 };
    const got = {};
    for (const [name, way] of Object.entries(cases)) {
      session.startEpoch({ session_id: name, source: 'startup' });
      session.update(name, (st) => { session.agentIn(st, 'main').shown['lesson:L1'] = way; });
      got[name] = /урок L1/.test(D.open('PreToolUse', { session_id: name, tool_use_id: 't1' }).finish({ items, final: null, reaches: () => true }).text);
    }
    assert.deepStrictEqual(got, { live: false, stale: true, dead: true, confirmed: false });
  } finally { if (before === undefined) delete process.env.HUB_LOG_DIR; else process.env.HUB_LOG_DIR = before; }
});
