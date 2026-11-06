// node --test plugin/hooks/memory-failure.test.cjs
// Slice 37: lessons on failed calls and the anchors of the matchers. A failed call (Bash exit ≠ 0, an MCP answer with
// isError, a JSON-RPC error or a timeout of an MCP tool, a failed Agent) is a PostToolUseFailure event — the lesson
// module there sees the text of the error as `out` (field `error` of the event: the text of the tool_result the model
// gets, probe P37 on Claude Code 2.1.317). Its matcher is the one of PostToolUse; the PreToolUse matcher gets anchors:
// Claude Code tests a matcher with anything but names and `|` as a regex WITHOUT anchors (probe P35) — `Task` let
// TaskList in, `Write` — TodoWrite. The module goes under the handler `memory`: the budget does not grow.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..');
const hot = require('./memory-hot.cjs');
const store = require('../lib/memory/store.cjs');
const registry = require('./lib/registry.cjs');
const made = [];
const mkdtemp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks.json'), 'utf8')).hooks;
// As Claude Code applies a matcher (P35, P37): empty or `*` — every tool; only names and `|` — an exact list; anything
// else — a regex tested WITHOUT anchors.
const asCC = (m, tool) => (!m || m === '*' ? true : /^[A-Za-z0-9_|]+$/.test(m) ? m.split('|').includes(tool) : new RegExp(m).test(tool));
const lets = (event, tool) => (hooks[event] || []).some((g) => asCC(g.matcher, tool));

// The tools PreToolUse took before slice 37 by name, and the ones its unanchored matcher let in besides.
const PRE = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'mcp__Claude_Browser__browser_batch', 'mcp__Claude_Browser__navigate',
  'mcp__claude-in-chrome__computer', 'mcp__claude-in-chrome__get_page_text'];
const LEAKED = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'BashOutput', 'KillBash', 'ListAgents',
  'mcp__x__EditFile', 'mcp__x__run_Bash', 'mcp__x__AgentTask', 'xmcp__claude-in-chrome__computer', 'mcp__plugin_x__mcp__Claude_Browser__y'];
const NEVER = ['Read', 'Grep', 'Glob', 'WebFetch', 'SendMessage', 'mcp__ccd_turn__update_plan', 'mcp__visualize__show_widget'];

test('PreToolUse: the matcher is anchored — the tools of before, by name, and nothing that only holds one of them', () => {
  for (const t of PRE) assert.ok(lets('PreToolUse', t), `${t} must reach PreToolUse`);
  for (const t of [...LEAKED, ...NEVER]) assert.ok(!lets('PreToolUse', t), `${t} must not reach PreToolUse`);
  for (const g of hooks.PreToolUse) assert.match(g.matcher, /^\^\(\?:.*\)\$$/, 'written as ^(?:…)$');
});

test('PostToolUseFailure: the matcher is the one of PostToolUse — a failed call of the same tools reaches the lessons', () => {
  assert.deepStrictEqual(hooks.PostToolUseFailure.map((g) => g.matcher), hooks.PostToolUse.map((g) => g.matcher));
  for (const t of ['Bash', 'Edit', 'Agent', 'Task', 'mcp__claude-in-chrome__computer', 'mcp__Claude_Browser__browser_batch',
    'mcp__plugin_studio-skills_tracker__tracker_issue', 'mcp__plugin_studio-skills_gitlab__gitlab_mr_create']) assert.ok(lets('PostToolUseFailure', t), t);
  for (const t of [...LEAKED, ...NEVER]) assert.ok(!lets('PostToolUseFailure', t), t);
});

// The event as Claude Code 2.1.317 sends it on a failed call (probe P37): no tool_response, the text in `error`.
const failed = (tool_name, error, tool_input = {}) => ({ hook_event_name: 'PostToolUseFailure', tool_name, tool_input, tool_use_id: 't', error,
  is_interrupt: false, duration_ms: 5 });
const outOf = (ev) => hot.fieldsOf(ev, { withOut: true }).out;

test('fieldsOf: out of a failed call — the text of its error, for every tool', () => {
  assert.strictEqual(outOf(failed('Bash', 'Exit code 3\nOUT-MARK\nERR-MARK', { command: 'x' })), 'Exit code 3\nOUT-MARK\nERR-MARK');
  assert.strictEqual(outOf(failed('mcp__claude-in-chrome__computer', 'MCP server "claude-in-chrome" tool "computer" timed out after 30s')),
    'MCP server "claude-in-chrome" tool "computer" timed out after 30s');
  assert.strictEqual(outOf(failed('mcp__plugin_studio-skills_gitlab__gitlab_mr', 'Project not found')), 'Project not found');
  assert.strictEqual(outOf(failed('Agent', "Agent type 'x' not found.")), "Agent type 'x' not found.");
  assert.strictEqual(outOf(failed('Edit', 'File has been modified since read')), 'File has been modified since read');
  assert.strictEqual(outOf(failed('Bash', '\x1b[31mboom\x1b[0m')), 'boom', 'ANSI codes are dropped');
});

test('fieldsOf: a failed call without a text error — empty out; the tail of CAP characters is kept', () => {
  assert.strictEqual(outOf(failed('Bash', undefined)), '');
  assert.strictEqual(outOf(failed('Bash', { message: 'x' })), '');
  const long = `${'а'.repeat(hot.CAP)}КОНЕЦ`;
  const out = outOf(failed('mcp__claude-in-chrome__computer', long));
  assert.strictEqual(out.length, hot.CAP);
  assert.ok(out.endsWith('КОНЕЦ'));
});

test('fieldsOf: PostToolUse is untouched — a stray error field is not read, tool_response is', () => {
  const ev = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: 'a', stderr: 'b' }, error: 'NOT-THIS' };
  assert.strictEqual(outOf(ev), 'a\nb');
  // the other fields of a failed call are what they would be after a finished one
  const f = hot.fieldsOf(failed('Bash', 'e', { command: 'npm test' }), { withOut: true });
  assert.deepStrictEqual({ tool: f.tool, cmd: f.cmd, path: f.path }, { tool: 'Bash', cmd: 'npm test', path: '' });
});

test('registry: the failure module is under the handler memory with the state of memory-lessons — the budget does not grow', () => {
  const list = registry.readRecords(path.join(PLUGIN, 'mechanisms'));
  const rec = (id) => (list.find((x) => x.rec && x.rec.id === id) || {}).rec;
  const f = rec('memory-lessons-failure');
  assert.ok(f, 'plugin/mechanisms/memory-lessons-failure.json');
  assert.strictEqual(f.event, 'PostToolUseFailure');
  assert.match(f.file, /^posttoolfailure\.d\/\d\d-memory-lessons-failure\.cjs$/);
  assert.ok(fs.existsSync(path.join(PLUGIN, 'hooks', f.file)), f.file);
  assert.strictEqual(f.handler, 'memory');
  assert.strictEqual(f.stage, 'canary');
  assert.strictEqual(f.onError, 'open');
  assert.deepStrictEqual(f.state, rec('memory-lessons').state);
  const count = (l) => ({ handlers: new Set(l.map((x) => x.rec && x.rec.handler).filter(Boolean)).size,
    state: new Set(l.flatMap((x) => (x.rec && Array.isArray(x.rec.state) ? x.rec.state : []))).size });
  assert.deepStrictEqual(count(list), count(list.filter((x) => !x.rec || x.rec.id !== 'memory-lessons-failure')));
  assert.ok(count(list).handlers <= registry.BUDGET.handlers && count(list).state <= registry.BUDGET.state);
});

// Through the runner, as Claude Code calls it on a failed call.
const lesson = (id, when, first) => ['---', `id: ${id}`, 'kind: rule', 'when:', ...when.flatMap((w) => Object.entries(w).map(([k, v], j) => `${j ? '    ' : '  - '}${k}: ${v}`)),
  'keys: []', 'status: active', 'supersedes: []', 'source: модель', 'created: 2026-10-01', '---', first, 'Вторая строка урока.', ''].join('\n');

function setup({ canary = true } = {}) {
  const hub = mkdtemp('memory-failure-');
  fs.cpSync(PLUGIN, path.join(hub, 'plugin'), { recursive: true, filter: (src) => !/\.test\.cjs$/.test(src) });
  const proj = path.join(hub, 'projects', 'demo');
  const mem = path.join(proj, 'memory');
  const wt = path.join(proj, 'worktrees', 'K-1');
  fs.mkdirSync(wt, { recursive: true });
  write(path.join(mem, 'errors-index.md'), '# Индекс\n');
  if (canary) write(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['delivery', 'memory'] }));
  write(path.join(mem, 'lessons', 'tab-timeout.md'), lesson('tab-timeout', [{ tool: '^mcp__(claude-in-chrome|Claude_Browser)__', out: 'timed out' }],
    'Таймаут браузера на фоновой вкладке — выведи вкладку вперёд, не повторяй вызов вслепую.'));
  write(path.join(mem, 'lessons', 'exit-127.md'), lesson('exit-127', [{ tool: '^Bash$', out: 'command not found' }], 'Команды нет в PATH — проверь окружение раннера.'));
  write(path.join(mem, 'lessons', 'agent-type.md'), lesson('agent-type', [{ tool: '^(Agent|Task)$', out: 'Agent type .* not found' }], 'Тип агента — с префиксом плагина.'));
  store.ensureTriggers(mem);
  return { hub, plugin: path.join(hub, 'plugin'), wt, logs: mkdtemp('memory-failure-logs-') };
}
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HUB_|AI_DEV_HUB|CLAUDE_PLUGIN|GIT_)/.test(k)));
let seq = 0;
function run(s, event, ev) {
  const r = spawnSync(process.execPath, [path.join(s.plugin, 'hooks', 'run.cjs'), event], {
    input: JSON.stringify({ hook_event_name: event, session_id: 's1', permission_mode: 'default', cwd: s.wt, tool_use_id: `t${++seq}`, ...ev }),
    encoding: 'utf8', timeout: 20000, env: { ...baseEnv(), AI_DEV_HUB: s.hub, HUB_LOG_DIR: s.logs, CLAUDE_PLUGIN_ROOT: s.plugin } });
  let json = null;
  try { json = r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null; } catch { /* plain */ }
  return { code: r.status, json, ctx: ((json && json.hookSpecificOutput) || {}).additionalContext || '' };
}
const fail = (s, tool_name, error, tool_input = {}) => run(s, 'PostToolUseFailure', { tool_name, tool_input, error, is_interrupt: false, duration_ms: 3 });

test('runner: a lesson on the error of a failed browser MCP call, Bash, Agent comes right after it', () => {
  const s = setup();
  run(s, 'SessionStart', { source: 'startup' });
  const page = fail(s, 'mcp__claude-in-chrome__computer', 'MCP server "claude-in-chrome" tool "computer" timed out after 30s', { action: 'screenshot' });
  assert.strictEqual(page.code, 0);
  assert.strictEqual(page.json && page.json.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(page.ctx, /Урок памяти \(tab-timeout\)/);
  assert.match(page.ctx, /\[Данные из памяти хаба/, 'in the frame of the delivery');
  assert.match(fail(s, 'Bash', 'Exit code 127\nbash: pnpm: command not found', { command: 'pnpm test' }).ctx, /Урок памяти \(exit-127\)/);
  assert.match(fail(s, 'Agent', "Agent type 'reviewer' not found. Available agents: hub:reviewer", { subagent_type: 'reviewer', prompt: 'x' }).ctx,
    /Урок памяти \(agent-type\)/);
  assert.doesNotMatch(fail(s, 'Bash', 'Exit code 1\nassertion failed', { command: 'npm test' }).ctx, /Урок памяти/, 'no lesson for this error');
});

test('runner: a lesson is delivered once per epoch across PostToolUse and PostToolUseFailure', () => {
  const s = setup();
  run(s, 'SessionStart', { source: 'startup' });
  const first = run(s, 'PostToolUse', { tool_name: 'mcp__claude-in-chrome__get_page_text', tool_input: {}, tool_response: [{ type: 'text', text: 'navigation timed out' }] });
  assert.match(first.ctx, /Урок памяти \(tab-timeout\)/);
  assert.doesNotMatch(fail(s, 'mcp__claude-in-chrome__computer', 'tool "computer" timed out after 30s').ctx, /Урок памяти \(tab-timeout\)/);
});

test('runner: without the canary the failure module is quiet', () => {
  const s = setup({ canary: false });
  run(s, 'SessionStart', { source: 'startup' });
  const r = fail(s, 'mcp__claude-in-chrome__computer', 'tool "computer" timed out after 30s');
  assert.strictEqual(r.code, 0);
  assert.doesNotMatch(r.ctx, /Урок памяти/);
});
