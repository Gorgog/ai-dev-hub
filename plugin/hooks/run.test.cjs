// node --test plugin/hooks/run.test.cjs
// The hook spine as Claude Code sees it: `node run.cjs <Event>` with the event on stdin, in a copy of the plugin
// whose modules (<event>.d/) and registry (mechanisms/) are synthetic.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOKS = __dirname;
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// A hub with projects/demo/worktrees/K-1 and a plugin copy holding the runner of this branch plus given modules.
// records: {id: {...}} — fields not given take the defaults of a valid record.
function setup({ modules = {}, records = {} } = {}) {
  const hub = mkdtemp('spine-');
  const plugin = path.join(hub, 'plugin');
  for (const f of ['run.cjs', 'pretool.cjs', 'session-start.cjs', 'stop.cjs', 'rules-guard.cjs', 'base-rules.json']) {
    if (fs.existsSync(path.join(HOOKS, f))) fs.cpSync(path.join(HOOKS, f), path.join(plugin, 'hooks', f));
  }
  if (fs.existsSync(path.join(HOOKS, 'lib'))) fs.cpSync(path.join(HOOKS, 'lib'), path.join(plugin, 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'mechanisms'), { recursive: true });
  for (const [file, src] of Object.entries(modules)) write(path.join(plugin, 'hooks', file), src);
  for (const [id, r] of Object.entries(records)) {
    write(path.join(plugin, 'mechanisms', `${id}.json`), typeof r === 'string' ? r : JSON.stringify({
      id, event: 'PreToolUse', handler: id, stage: 'on', onError: 'open', failScope: 'any', state: [], reads: [],
      polygon: ['H01'], replaces: '—', review: '2099-01-01', ...r }));
  }
  const wt = path.join(hub, 'projects', 'demo', 'worktrees', 'K-1');
  const outside = mkdtemp('elsewhere-');
  fs.mkdirSync(wt, { recursive: true });
  const logs = mkdtemp('spine-logs-');
  const mark = path.join(logs, 'mark.txt');
  return { hub, plugin, wt, outside, logs, mark };
}

// One hook call. The environment is cut down to what the runner may read: no HUB_OFF from the caller's shell.
function run(s, event, ev, env = {}, script = 'run.cjs') {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HUB_|AI_DEV_HUB|CLAUDE_PLUGIN)/.test(k)));
  const r = spawnSync(process.execPath, [path.join(s.plugin, 'hooks', script), ...(script === 'run.cjs' ? [event] : [])], {
    input: JSON.stringify({ hook_event_name: event, session_id: 's1', ...ev }), encoding: 'utf8', timeout: 20000,
    env: { ...base, AI_DEV_HUB: s.hub, HUB_LOG_DIR: s.logs, MARK: s.mark, CLAUDE_PLUGIN_ROOT: s.plugin, ...env },
  });
  let json = null;
  try { json = r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null; } catch { /* plain text */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const marks = (s) => (fs.existsSync(s.mark) ? fs.readFileSync(s.mark, 'utf8').split('\n').filter(Boolean) : []);
const journal = (s) => {
  const f = path.join(s.logs, 'hooks.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// A module that marks its call and hands one item to the delivery.
const marker = (id, text = id.toUpperCase(), extra = '') => `module.exports = { id: '${id}', run(ev, ctx) {
  require('fs').appendFileSync(process.env.MARK, '${id}\\n'); ${extra}
  return { items: [{ text: '${text}', priority: 'reminder', key: '${id}' }] };
} };\n`;
const BROKEN = "throw new Error('module is broken');\n";
const bash = (cwd, command = 'ls') => ({ cwd, tool_name: 'Bash', tool_input: { command } });

test('spine: modules run in file-name order, their items reach Claude through one delivery point', () => {
  const s = setup({
    modules: { 'pretool.d/20-b.cjs': marker('b'), 'pretool.d/10-a.cjs': marker('a'), 'sessionstart.d/10-c.cjs': marker('c', 'Бриф C') },
    records: { a: { file: 'pretool.d/10-a.cjs' }, b: { file: 'pretool.d/20-b.cjs' }, c: { file: 'sessionstart.d/10-c.cjs', event: 'SessionStart' } },
  });
  const r = run(s, 'PreToolUse', bash(s.wt));
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(marks(s), ['a', 'b']);
  assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(r.json.hookSpecificOutput.additionalContext, 'A\nB');
  const st = run(s, 'SessionStart', { cwd: s.wt, source: 'startup' });
  assert.strictEqual(st.code, 0, st.err);
  assert.match(st.out, /^Бриф C\n?$/m, 'SessionStart delivers plain text, as v1');
});

test('spine: HUB_OFF=1 and the flag file <hub>/.hub-off — no module runs, every event is silent', () => {
  const s = setup({
    modules: { 'pretool.d/10-a.cjs': marker('a'), 'stop.d/10-s.cjs': marker('s'), 'sessionstart.d/10-c.cjs': marker('c') },
    records: { a: { file: 'pretool.d/10-a.cjs' }, s: { file: 'stop.d/10-s.cjs', event: 'Stop' }, c: { file: 'sessionstart.d/10-c.cjs', event: 'SessionStart' } },
  });
  const calls = [['PreToolUse', bash(s.wt)], ['Stop', { cwd: s.wt }], ['SessionStart', { cwd: s.wt, source: 'startup' }]];
  for (const [event, ev] of calls) {
    const r = run(s, event, ev, { HUB_OFF: '1' });
    assert.strictEqual(r.code, 0, `${event}: ${r.err}`);
    assert.strictEqual(r.out, '', event);
  }
  fs.writeFileSync(path.join(s.hub, '.hub-off'), '');
  for (const [event, ev] of calls) {
    const r = run(s, event, ev);
    assert.strictEqual(r.code, 0, `${event}: ${r.err}`);
    assert.strictEqual(r.out, '', event);
  }
  assert.deepStrictEqual(marks(s), []);
  fs.rmSync(path.join(s.hub, '.hub-off'));
  run(s, 'PreToolUse', bash(s.wt));
  assert.deepStrictEqual(marks(s), ['a'], 'control: without the switch the module runs');
});

test('spine: an event without modules exits 0, silently', () => {
  const s = setup();
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionStart', 'SessionEnd', 'SubagentStart']) {
    const r = spawnSync(process.execPath, [path.join(s.plugin, 'hooks', 'run.cjs'), event], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, AI_DEV_HUB: s.hub, HUB_LOG_DIR: s.logs },
    });
    assert.strictEqual(r.status, 0, `${event}: ${r.stderr}`);
    assert.strictEqual(r.stdout, '', event);
  }
});

test('spine: a broken delivery module fails open — the call passes, the error is journaled with the hub version', () => {
  const s = setup({
    modules: { 'pretool.d/10-bad.cjs': BROKEN, 'pretool.d/20-a.cjs': marker('a'), 'sessionstart.d/10-bad.cjs': BROKEN },
    records: { bad: { file: 'pretool.d/10-bad.cjs' }, a: { file: 'pretool.d/20-a.cjs' }, sbad: { file: 'sessionstart.d/10-bad.cjs', event: 'SessionStart' } },
  });
  const r = run(s, 'PreToolUse', bash(s.wt));
  assert.strictEqual(r.code, 0, r.err);
  assert.notStrictEqual(r.json && r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepStrictEqual(marks(s), ['a'], 'the next module still runs');
  assert.strictEqual(run(s, 'SessionStart', { cwd: s.wt, source: 'startup' }).code, 0);
  const errs = journal(s).filter((e) => e.type === 'error');
  assert.strictEqual(errs.length, 2, JSON.stringify(journal(s)));
  assert.match(errs[0].module, /10-bad\.cjs/);
  assert.match(errs[0].error, /module is broken/);
  assert.strictEqual(errs[0].policy, 'open');
  assert.ok('hub' in errs[0], 'the version label is in the journal line');
});

test('spine: a broken protection module fails closed in its scope — deny with the reason and the way out', () => {
  const s = setup({
    modules: { 'pretool.d/10-lock.cjs': BROKEN, 'pretool.d/20-a.cjs': marker('a') },
    records: { lock: { file: 'pretool.d/10-lock.cjs', onError: 'closed', failScope: 'worktree' }, a: { file: 'pretool.d/20-a.cjs' } },
  });
  const r = run(s, 'PreToolUse', bash(s.wt, 'npx jest'));
  assert.strictEqual(r.code, 0, r.err);
  const o = r.json.hookSpecificOutput;
  assert.strictEqual(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /10-lock\.cjs/);
  assert.match(o.permissionDecisionReason, /module is broken/);
  assert.match(o.permissionDecisionReason, /HUB_OFF=1/);
  assert.match(o.permissionDecisionReason, /\.hub-off/);
  assert.deepStrictEqual(marks(s), [], 'a closed failure stops the chain');
  // Out of its scope (not a worktree of a hub project) the same failure passes the call.
  const out = run(s, 'PreToolUse', bash(s.outside, 'npx jest'));
  assert.notStrictEqual(out.json && out.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepStrictEqual(marks(s), ['a']);
  // A worktree-like path of another repository (…/projects/x/worktrees/y outside this hub) is not in scope either.
  const foreign = path.join(s.outside, 'projects', 'app', 'worktrees', 'feat');
  fs.mkdirSync(foreign, { recursive: true });
  const f = run(s, 'PreToolUse', bash(foreign, 'ls'));
  assert.notStrictEqual(f.json && f.json.hookSpecificOutput.permissionDecision, 'deny', f.out);
  assert.deepStrictEqual(journal(s).filter((e) => e.type === 'error').map((e) => e.policy), ['closed', 'open', 'open']);
});

test('spine: a long delivery reaches a slow reader whole — the runner exits only after its output is written', () => {
  const s = setup({
    modules: { 'sessionstart.d/10-big.cjs': "module.exports = { id: 'big', run() { return { items: [{ text: 'я'.repeat(150000) }] }; } };\n" },
    records: { big: { file: 'sessionstart.d/10-big.cjs', event: 'SessionStart' } },
  });
  const input = path.join(s.logs, 'ev.json');
  fs.writeFileSync(input, JSON.stringify({ hook_event_name: 'SessionStart', cwd: s.outside, source: 'startup' }));
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HUB_|AI_DEV_HUB)/.test(k)));
  const r = spawnSync('sh', ['-c', `"${process.execPath}" "${path.join(s.plugin, 'hooks', 'run.cjs')}" SessionStart < "${input}" | (sleep 0.5; wc -c)`], {
    encoding: 'utf8', env: { ...base, AI_DEV_HUB: s.hub, HUB_LOG_DIR: s.logs } });
  assert.strictEqual(Number(r.stdout.trim()), Buffer.byteLength('я'.repeat(150000) + '\n'), r.stderr);
});

test('spine health: a module without a registry record is named at the start', () => {
  const s = setup({ modules: { 'pretool.d/30-x.cjs': marker('x') } });
  const r = run(s, 'SessionStart', { cwd: s.outside, source: 'startup' });
  assert.match(r.out, /Здоровье хаба/);
  assert.match(r.out, /pretool\.d\/30-x\.cjs/);
});

test('spine: PostToolUseFailure — modules of posttoolfailure.d, their items as additionalContext', () => {
  const s = setup({ modules: { 'posttoolfailure.d/10-f.cjs': marker('f', 'урок по ошибке') }, records: { f: { file: 'posttoolfailure.d/10-f.cjs', event: 'PostToolUseFailure' } } });
  const r = run(s, 'PostToolUseFailure', { ...bash(s.wt, 'false'), error: 'exit 1' });
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(r.json, { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'урок по ошибке' } });
});

test('spine: a broken Stop protection blocks once, never on stop_hook_active (no loop)', () => {
  const s = setup({ modules: { 'stop.d/10-gate.cjs': BROKEN }, records: { gate: { file: 'stop.d/10-gate.cjs', event: 'Stop', onError: 'closed', failScope: 'project' } } });
  const r = run(s, 'Stop', { cwd: s.wt, stop_hook_active: false });
  assert.strictEqual(r.json && r.json.decision, 'block', r.out + r.err);
  assert.match(r.json.reason, /10-gate\.cjs/);
  const again = run(s, 'Stop', { cwd: s.wt, stop_hook_active: true });
  assert.strictEqual(again.code, 0);
  assert.strictEqual(again.out, '');
});

test('spine: a module result outside the contract is a broken module; stdout of a module never reaches Claude', () => {
  const s = setup({
    modules: {
      'pretool.d/10-bad.cjs': "module.exports = { id: 'bad', run() { return { decision: 'maybe' }; } };\n",
      'pretool.d/20-noisy.cjs': marker('noisy', 'N', "process.stdout.write('garbage');"),
    },
    records: { bad: { file: 'pretool.d/10-bad.cjs' }, noisy: { file: 'pretool.d/20-noisy.cjs' } },
  });
  const r = run(s, 'PreToolUse', bash(s.wt));
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.json, `stdout is one JSON object: ${r.out}`);
  assert.strictEqual(r.json.hookSpecificOutput.additionalContext, 'N');
  const types = journal(s).map((e) => `${e.type}:${path.basename(e.module || '')}`);
  assert.ok(types.includes('error:10-bad.cjs'), types.join());
  assert.ok(types.includes('stdout:20-noisy.cjs'), types.join());
});

test('spine: decisions — block is exit 2 with the reason on stderr (v1 lock), deny/ask are JSON; a block ends the chain', () => {
  const s = setup({
    modules: {
      'pretool.d/10-lock.cjs': "module.exports = { id: 'lock', run(ev) { return /jest/.test(ev.tool_input.command) ? { decision: 'block', reason: 'занято\\n' } : null; } };\n",
      'pretool.d/20-rules.cjs': "module.exports = { id: 'rules', run(ev) { require('fs').appendFileSync(process.env.MARK, 'rules\\n'); return /push/.test(ev.tool_input.command) ? { decision: 'ask', reason: 'пуш?' } : null; } };\n",
    },
    records: { lock: { file: 'pretool.d/10-lock.cjs' }, rules: { file: 'pretool.d/20-rules.cjs' } },
  });
  const b = run(s, 'PreToolUse', bash(s.wt, 'npx jest'));
  assert.strictEqual(b.code, 2);
  assert.strictEqual(b.err, 'занято\n');
  assert.strictEqual(b.out, '');
  assert.deepStrictEqual(marks(s), []);
  const a = run(s, 'PreToolUse', bash(s.wt, 'git push'));
  assert.strictEqual(a.code, 0);
  assert.deepStrictEqual(a.json, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'пуш?' } });
  const none = run(s, 'PreToolUse', bash(s.wt, 'ls'));
  assert.strictEqual(none.out, '');
});

test('spine: stages — off never runs, canary only in projects listed in projects/<name>/canary.json, on everywhere', () => {
  const s = setup({
    modules: { 'pretool.d/10-off.cjs': marker('off'), 'pretool.d/20-can.cjs': marker('can'), 'pretool.d/30-on.cjs': marker('on') },
    records: { off: { file: 'pretool.d/10-off.cjs', stage: 'off' }, can: { file: 'pretool.d/20-can.cjs', stage: 'canary' }, on: { file: 'pretool.d/30-on.cjs' } },
  });
  run(s, 'PreToolUse', bash(s.wt));
  assert.deepStrictEqual(marks(s), ['on']);
  write(path.join(s.hub, 'projects', 'demo', 'canary.json'), JSON.stringify({ mechanisms: ['can'] }));
  fs.rmSync(s.mark);
  run(s, 'PreToolUse', bash(s.wt));
  assert.deepStrictEqual(marks(s), ['can', 'on']);
  fs.rmSync(s.mark);
  run(s, 'PreToolUse', bash(s.outside));
  assert.deepStrictEqual(marks(s), ['on'], 'outside the hub projects a canary does not run');
});

test('spine: the module gets the event and the context — project, worktree, stage, version', () => {
  const s = setup({
    modules: { 'pretool.d/10-ctx.cjs': "module.exports = { id: 'ctx', run(ev, ctx) { require('fs').writeFileSync(process.env.MARK, JSON.stringify({ tool: ev.tool_name, project: ctx.project && ctx.project.name, worktree: ctx.worktree, stage: ctx.stage, hub: ctx.hub, version: typeof ctx.version })); return null; } };\n" },
    records: { ctx: { file: 'pretool.d/10-ctx.cjs' } },
  });
  run(s, 'PreToolUse', bash(s.wt));
  const c = JSON.parse(fs.readFileSync(s.mark, 'utf8'));
  assert.deepStrictEqual(c, { tool: 'Bash', project: 'demo', worktree: 'K-1', stage: 'on', hub: s.hub, version: 'string' });
});

test('spine health on SessionStart: a broken registry record is reported; the start is journaled with the version', () => {
  const s = setup({ records: { bad: '{ not json' } });
  const r = run(s, 'SessionStart', { cwd: s.outside, source: 'startup' });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /Здоровье хаба/);
  assert.match(r.out, /mechanisms\/bad\.json/);
  const start = journal(s).find((e) => e.type === 'health');
  assert.ok(start, JSON.stringify(journal(s)));
  assert.ok(Array.isArray(start.problems) && start.problems.length >= 1);
  assert.ok('hub' in start);
});

test('spine health: hooks run from a working tree off main or with uncommitted plugin/ edits — said at the start', () => {
  const s = setup({ modules: { 'sessionstart.d/10-c.cjs': marker('c', 'бриф') }, records: { c: { file: 'sessionstart.d/10-c.cjs', event: 'SessionStart' } } });
  const git = (...a) => execFileSync('git', a, { cwd: s.hub, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', 'plugin'); git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', '--short', 'HEAD');
  const clean = run(s, 'SessionStart', { cwd: s.outside, source: 'startup' });
  assert.doesNotMatch(clean.out, /Здоровье хаба/);
  assert.strictEqual(journal(s).filter((e) => e.type === 'health').pop().hub, sha);
  fs.appendFileSync(path.join(s.plugin, 'hooks', 'sessionstart.d', '10-c.cjs'), '// local edit\n');
  const dirty = run(s, 'SessionStart', { cwd: s.outside, source: 'startup' });
  assert.match(dirty.out, /Здоровье хаба/);
  assert.match(dirty.out, /незакоммичен/);
  git('switch', '-q', '-c', 'side');
  assert.match(run(s, 'SessionStart', { cwd: s.outside, source: 'startup' }).out, /не на main/);
});

test('v1 entry points stay: pretool.cjs, session-start.cjs, stop.cjs run the spine (live sessions keep their hooks.json)', () => {
  const s = setup({
    modules: { 'pretool.d/10-a.cjs': marker('a'), 'stop.d/10-s.cjs': marker('s'), 'sessionstart.d/10-c.cjs': marker('c') },
    records: { a: { file: 'pretool.d/10-a.cjs' }, s: { file: 'stop.d/10-s.cjs', event: 'Stop' }, c: { file: 'sessionstart.d/10-c.cjs', event: 'SessionStart' } },
  });
  run(s, 'PreToolUse', bash(s.wt), {}, 'pretool.cjs');
  run(s, 'SessionStart', { cwd: s.wt, source: 'startup' }, {}, 'session-start.cjs');
  run(s, 'Stop', { cwd: s.wt }, {}, 'stop.cjs');
  assert.deepStrictEqual(marks(s), ['a', 'c', 's']);
});

test('hooks.json: every event of the plan goes to the runner, nothing else', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8')).hooks;
  assert.deepStrictEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart']);
  for (const [event, groups] of Object.entries(hooks)) {
    const cmds = groups.flatMap((g) => g.hooks);
    assert.strictEqual(cmds.length, 1, event);
    assert.deepStrictEqual(cmds[0].args, ['${CLAUDE_PLUGIN_ROOT}/hooks/run.cjs', event]);
  }
});
