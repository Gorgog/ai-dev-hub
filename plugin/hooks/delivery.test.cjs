// node --test plugin/hooks/delivery.test.cjs
// The delivery through the spine, as Claude Code sees it: `node run.cjs <Event>` with the event on stdin, in a copy of
// the plugin with this branch's runner, lib/, epoch modules and their registry records, plus synthetic modules that
// hand a lesson (with a detector) and a deny-once to the delivery.
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

const MODULES = {
  // A lesson for every command with BAD; the lesson id is the word after it, L1 by default.
  'pretool.d/10-lesson.cjs': `module.exports = { id: 'lesson', run(ev) {
    const m = /BAD(?:-(\\S+))?/.exec((ev.tool_input || {}).command || '');
    if (!m) return null;
    const id = m[1] || 'L1';
    return { items: [{ text: 'урок ' + id + ': не делай BAD', priority: 'lesson', key: id, lesson: id, detector: 'D-' + id, source: 'memory' }] };
  } };\n`,
  'pretool.d/20-once.cjs': `module.exports = { id: 'once', run(ev) {
    if (!/REPEAT/.test((ev.tool_input || {}).command || '')) return null;
    return { decision: 'deny', reason: 'урок L2: это повтор', once: 'L2', lesson: 'L2', detector: 'D-L2' };
  } };\n`,
  'pretool.d/30-mark.cjs': `module.exports = { id: 'mark', run(ev, ctx) {
    require('fs').appendFileSync(process.env.MARK, 'mark:' + ctx.epoch + '\\n');
    return null;
  } };\n`,
  'sessionstart.d/10-brief.cjs': `module.exports = { id: 'brief', run() { return { items: [{ text: 'Бриф', priority: 'info', key: 'brief' }] }; } };\n`,
};

function setup({ stage = null, canary = true } = {}) {
  const hub = mkdtemp('delivery-');
  const plugin = path.join(hub, 'plugin');
  fs.cpSync(path.join(HOOKS, 'run.cjs'), path.join(plugin, 'hooks', 'run.cjs'));
  fs.cpSync(path.join(HOOKS, 'lib'), path.join(plugin, 'hooks', 'lib'), { recursive: true });
  for (const f of ['sessionstart.d/00-delivery.cjs', 'subagentstart.d/00-delivery.cjs']) fs.cpSync(path.join(HOOKS, f), path.join(plugin, 'hooks', f));
  for (const id of ['delivery', 'delivery-subagent']) {
    const rec = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'mechanisms', `${id}.json`), 'utf8'));
    write(path.join(plugin, 'mechanisms', `${id}.json`), JSON.stringify(stage ? { ...rec, stage } : rec));
  }
  for (const [file, src] of Object.entries(MODULES)) {
    write(path.join(plugin, 'hooks', file), src);
    const id = /module.exports = \{ id: '([^']+)'/.exec(src)[1];
    write(path.join(plugin, 'mechanisms', `${id}.json`), JSON.stringify({ id, event: file.startsWith('pretool') ? 'PreToolUse' : 'SessionStart',
      file, handler: id, stage: 'on', onError: 'open', failScope: 'any', state: [], reads: [], polygon: ['H14'], replaces: '—', review: '2099-01-01' }));
  }
  const proj = path.join(hub, 'projects', 'demo');
  const wt = path.join(proj, 'worktrees', 'K-1');
  fs.mkdirSync(wt, { recursive: true });
  if (canary) write(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['delivery'] }));
  const logs = mkdtemp('delivery-logs-');
  return { hub, plugin, wt, logs, mark: path.join(logs, 'mark.txt') };
}

const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HUB_|AI_DEV_HUB|CLAUDE_PLUGIN)/.test(k)));
const envOf = (s, env) => ({ ...baseEnv(), AI_DEV_HUB: s.hub, HUB_LOG_DIR: s.logs, MARK: s.mark, CLAUDE_PLUGIN_ROOT: s.plugin, ...env });
const input = (event, ev) => JSON.stringify({ hook_event_name: event, session_id: 's1', permission_mode: 'default', ...ev });

function run(s, event, ev = {}, env = {}) {
  const r = spawnSync(process.execPath, [path.join(s.plugin, 'hooks', 'run.cjs'), event], {
    input: input(event, { cwd: s.wt, ...ev }), encoding: 'utf8', timeout: 20000, env: envOf(s, env) });
  let json = null;
  try { json = r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null; } catch { /* plain text */ }
  const ctx = json && json.hookSpecificOutput ? json.hookSpecificOutput.additionalContext || '' : '';
  return { code: r.status, out: r.stdout, err: r.stderr, json, ctx };
}
const pre = (s, id, command, extra = {}, env = {}) => run(s, 'PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...extra }, env);
const marks = (s) => (fs.existsSync(s.mark) ? fs.readFileSync(s.mark, 'utf8').split('\n').filter(Boolean) : []);
function journal(s) {
  const dir = path.join(s.logs, 'events');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

test('delivery: one lesson per epoch — again after compaction and in a subagent, not after resume', () => {
  const s = setup();
  assert.match(run(s, 'SessionStart', { source: 'startup', model: 'claude-test' }).out, /Бриф/);
  assert.match(pre(s, 't1', 'echo BAD').ctx, /урок L1/);
  assert.strictEqual(pre(s, 't2', 'echo BAD').ctx, '', 'the same epoch');
  assert.doesNotMatch(run(s, 'SessionStart', { source: 'resume' }).out, /Бриф/, 'resume keeps the epoch: the brief is in context already');
  assert.strictEqual(pre(s, 't3', 'echo BAD').ctx, '');
  assert.match(run(s, 'SessionStart', { source: 'compact' }).out, /Бриф/, 'compaction opens an epoch');
  assert.match(pre(s, 't4', 'echo BAD').ctx, /урок L1/);
  assert.strictEqual(run(s, 'SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' }).code, 0);
  assert.match(pre(s, 't5', 'echo BAD', { agent_id: 'a1' }).ctx, /урок L1/, 'a subagent has its own epoch');
  assert.strictEqual(pre(s, 't6', 'echo BAD', { agent_id: 'a1' }).ctx, '');
  assert.strictEqual(pre(s, 't7', 'echo BAD').ctx, '', 'the main thread still remembers');
  assert.match(pre(s, 't8', 'echo BAD-L9').ctx, /данные из памяти/i, 'a lesson from memory is framed');
  assert.deepStrictEqual(marks(s), ['mark:1', 'mark:1', 'mark:1', 'mark:2', 'mark:1', 'mark:1', 'mark:2', 'mark:2'], 'modules get the epoch of their agent');
});

test('delivery: every delivery is an event line with the whole address of the call', () => {
  const s = setup();
  run(s, 'SessionStart', { source: 'startup', model: 'claude-test' });
  pre(s, 't1', 'echo BAD');
  pre(s, 't2', 'echo BAD');
  run(s, 'SubagentStart', { agent_id: 'a1' });
  pre(s, 't3', 'echo BAD', { agent_id: 'a1', permission_mode: 'acceptEdits' });
  const ev = journal(s);
  const shown = ev.filter((e) => e.kind === 'shown');
  for (const e of ev) {
    for (const k of ['at', 'kind', 'session_id', 'agent_id', 'tool_use_id', 'epoch', 'model', 'mode', 'event']) assert.ok(k in e, `${k} in ${JSON.stringify(e)}`);
    assert.ok(e.lesson || e.rule, JSON.stringify(e));
  }
  assert.deepStrictEqual(shown.map((e) => [e.lesson || e.rule, e.agent_id, e.tool_use_id, e.epoch, e.model, e.mode]), [
    ['brief', 'main', null, 1, 'claude-test', 'default'],
    ['L1', 'main', 't1', 1, 'claude-test', 'default'],
    ['L1', 'a1', 't3', 1, 'claude-test', 'acceptEdits'],
  ]);
  assert.deepStrictEqual(ev.filter((e) => e.kind === 'repeat').map((e) => [e.lesson, e.tool_use_id, e.calls, e.window]), [['L1', 't2', 1, true]]);
});

test('delivery: deny-once — the first repeat is denied with the lesson, the next one passes and the chain goes on', () => {
  const s = setup();
  run(s, 'SessionStart', { source: 'startup' });
  const first = pre(s, 't1', 'echo REPEAT');
  assert.strictEqual(first.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /урок L2/);
  assert.deepStrictEqual(marks(s), [], 'a deny ends the chain');
  const second = pre(s, 't2', 'echo REPEAT');
  assert.ok(!second.json || !second.json.hookSpecificOutput.permissionDecision, second.out);
  assert.deepStrictEqual(marks(s), ['mark:1'], 'the dropped deny does not cut the modules after it');
  const ev = journal(s).filter((e) => e.lesson === 'L2').map((e) => `${e.kind}:${e.tool_use_id}`);
  assert.deepStrictEqual(ev, ['deny:t1', 'repeat:t2']);
});

test('delivery: stage off or a project outside the canary — the delivery of 08, no state, no events', () => {
  for (const s of [setup({ stage: 'off' }), setup({ canary: false })]) {
    run(s, 'SessionStart', { source: 'startup' });
    assert.match(pre(s, 't1', 'echo BAD').ctx, /урок L1/);
    assert.match(pre(s, 't2', 'echo BAD').ctx, /урок L1/, 'shown again, as before the slice');
    assert.doesNotMatch(pre(s, 't3', 'echo BAD').ctx, /данные из памяти/i, 'no frame either: exactly the old text');
    assert.ok(!fs.existsSync(path.join(s.logs, 'events')));
    assert.ok(!fs.existsSync(path.join(s.logs, 'sessions')));
    assert.deepStrictEqual(marks(s), ['mark:null', 'mark:null', 'mark:null']);
  }
});

test('delivery: fails open — a broken state file or an unwritable data folder never loses the text or the call', () => {
  const s = setup();
  run(s, 'SessionStart', { source: 'startup' });
  for (const f of fs.readdirSync(path.join(s.logs, 'sessions'))) fs.writeFileSync(path.join(s.logs, 'sessions', f), '\0\0garbage');
  const r = pre(s, 't1', 'echo BAD');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.ctx, /урок L1/);
  const blocked = path.join(s.logs, 'file-not-dir');
  fs.writeFileSync(blocked, '');
  for (const [event, ev] of [['SessionStart', { source: 'startup' }], ['PreToolUse', { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'echo BAD' } }]]) {
    const x = run(s, event, ev, { HUB_LOG_DIR: blocked });
    assert.strictEqual(x.code, 0, x.err);
    assert.match(x.out, event === 'SessionStart' ? /Бриф/ : /урок L1/);
  }
  const deny = run(s, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 't3', tool_input: { command: 'echo REPEAT' } }, { HUB_LOG_DIR: blocked });
  assert.strictEqual(deny.json.hookSpecificOutput.permissionDecision, 'deny', 'without state a deny-once still denies');
});

test('delivery: 7 sessions at once through the runner — every event line whole, none lost', async () => {
  const s = setup();
  const one = (sid, i) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(s.plugin, 'hooks', 'run.cjs'), 'PreToolUse'], { env: envOf(s, {}), stdio: ['pipe', 'ignore', 'inherit'] });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${sid}/${i}: ${code}`))));
    c.stdin.end(input('PreToolUse', { session_id: sid, cwd: s.wt, tool_name: 'Bash', tool_use_id: `t${i}`, tool_input: { command: `echo BAD-L${i}` } }));
  });
  await Promise.all(Array.from({ length: 7 }, async (_, p) => { for (let i = 0; i < 12; i++) await one(`p${p}`, i); }));
  const ev = journal(s);
  assert.strictEqual(ev.filter((e) => e.kind === 'shown').length, 7 * 12);
  for (let p = 0; p < 7; p++) assert.deepStrictEqual(ev.filter((e) => e.session_id === `p${p}` && e.kind === 'shown').map((e) => e.lesson).sort(),
    Array.from({ length: 12 }, (_, i) => `L${i}`).sort());
});
