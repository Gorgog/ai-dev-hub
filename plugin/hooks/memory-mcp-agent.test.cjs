// node --test plugin/hooks/memory-mcp-agent.test.cjs
// Lessons after MCP and Agent calls (slice 35, decision 06.11 variant A): the PostToolUse matcher of hooks.json lets in
// Agent/Task and the MCP tools lessons are written for — the browser (claude-in-chrome, Claude_Browser), the tracker,
// GitLab; not the app's service MCP (ccd_*) and not any MCP at all. PostToolUseFailure stays as it was. The lesson
// module sees `out` of those calls — the text blocks of the MCP result / of the agent's report; the out of the tools
// seen before (Bash, Edit, Write, …) is byte for byte what it was.
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
const made = [];
const mkdtemp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks.json'), 'utf8')).hooks;
// As Claude Code (2.1.317, review 06.11) applies a matcher: only names and `|` — an exact list; anything else — a
// regex tested WITHOUT anchors (`Write` would let TodoWrite in, `Task` — TaskStop).
const lets = (event, tool) => hooks[event].some((g) => (/^[A-Za-z0-9_|]+$/.test(g.matcher) ? g.matcher.split('|').includes(tool) : new RegExp(g.matcher).test(tool)));
const OLD = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const NEW = ['Agent', 'Task', 'mcp__claude-in-chrome__computer', 'mcp__claude-in-chrome__get_page_text', 'mcp__Claude_Browser__browser_batch',
  'mcp__Claude_Browser__javascript_tool', 'mcp__plugin_studio-skills_tracker__tracker_issue', 'mcp__plugin_studio-skills_gitlab__gitlab_mr_create',
  'mcp__plugin_studio-skills_gitlab__gitlab_note'];
const NOT = ['Read', 'Grep', 'Glob', 'WebFetch', 'SendMessage', 'mcp__ccd_turn__update_plan', 'mcp__ccd_session__start_session', 'mcp__figma-local__get_screenshot',
  'mcp__visualize__show_widget', 'mcp__terminal__read_terminal',
  // a name of before or a new one inside another name: unanchored, the matcher would let these in
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'BashOutput', 'KillBash', 'ListAgents',
  'mcp__x__EditFile', 'mcp__x__run_Bash', 'mcp__x__AgentTask', 'xmcp__claude-in-chrome__computer'];

test('PostToolUse: the matcher lets in Agent/Task and the browser, tracker and GitLab MCP — as well as the tools of before', () => {
  for (const t of [...OLD, ...NEW]) assert.ok(lets('PostToolUse', t), t);
});

test('PostToolUse: not the app service MCP, not other MCP, not the read-only built-ins', () => {
  for (const t of NOT) assert.ok(!lets('PostToolUse', t), t);
});

test('PostToolUseFailure and PreToolUse: the matchers are as they were', () => {
  assert.deepStrictEqual(hooks.PostToolUseFailure.map((g) => g.matcher), ['Bash|Edit|Write|MultiEdit|NotebookEdit']);
  assert.deepStrictEqual(hooks.PreToolUse.map((g) => g.matcher), ['Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|mcp__Claude_Browser__.*|mcp__claude-in-chrome__.*']);
});

const outOf = (tool_name, tool_response, tool_input = {}) => hot.fieldsOf({ tool_name, tool_input, tool_response }, { withOut: true }).out;

test('fieldsOf: out of an MCP call — its text blocks, as an array, an object with content or a string', () => {
  const blocks = [{ type: 'text', text: 'Задача K-123 открыта' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'вторая' }];
  assert.strictEqual(outOf('mcp__claude-in-chrome__get_page_text', blocks), 'Задача K-123 открыта\nвторая');
  assert.strictEqual(outOf('mcp__Claude_Browser__javascript_tool', { content: blocks }), 'Задача K-123 открыта\nвторая');
  assert.strictEqual(outOf('mcp__plugin_studio-skills_tracker__tracker_issue', '{"summary":"x"}'), '{"summary":"x"}');
  assert.strictEqual(outOf('mcp__claude-in-chrome__computer', { content: '\x1b[31mtimeout\x1b[0m' }), 'timeout', 'ANSI codes are dropped');
  assert.strictEqual(outOf('mcp__claude-in-chrome__computer', [{ type: 'image', data: 'AAAA' }]), '', 'no text — empty');
  assert.strictEqual(outOf('mcp__claude-in-chrome__computer', null), '');
  assert.strictEqual(outOf('mcp__claude-in-chrome__computer', [null, 5, { type: 'text', text: 7 }, { type: 'text', text: 'ok' }]), 'ok', 'odd blocks are skipped');
});

test('fieldsOf: out of an Agent call — the text of its report; an async launch has none', () => {
  const done = { status: 'completed', prompt: 'Найди', content: [{ type: 'text', text: 'Отчёт: ERR_CONNECTION_RESET на стенде' }], totalDurationMs: 10 };
  assert.strictEqual(outOf('Agent', done), 'Отчёт: ERR_CONNECTION_RESET на стенде');
  assert.strictEqual(outOf('Task', done), 'Отчёт: ERR_CONNECTION_RESET на стенде');
  assert.strictEqual(outOf('Agent', { isAsync: true, status: 'async_launched', agentId: 'a1', prompt: 'x' }), '');
});

test('fieldsOf: an agent that handed its report back (SubagentHandback) — out is the report, not the stub in content', () => {
  const handback = { status: 'completed', handback: 'send', handbackReport: { text: 'Отчёт: стенд отдал ERR_CONNECTION_RESET' },
    content: [{ type: 'text', text: 'This agent\'s report was delivered to you as a message from "a1" (its SubagentHandback call).' }] };
  assert.strictEqual(outOf('Agent', handback), 'Отчёт: стенд отдал ERR_CONNECTION_RESET');
  assert.strictEqual(outOf('Agent', { ...handback, handbackReport: { text: 5 } }), handback.content[0].text, 'no text in the report — content');
  assert.strictEqual(outOf('Agent', { ...handback, handbackReport: null }), handback.content[0].text);
});

test('fieldsOf: out keeps the tail of CAP characters for the new tools too', () => {
  const long = `${'а'.repeat(hot.CAP)}КОНЕЦ`;
  const out = outOf('mcp__claude-in-chrome__get_page_text', [{ type: 'text', text: long }]);
  assert.strictEqual(out.length, hot.CAP);
  assert.ok(out.endsWith('КОНЕЦ'));
});

test('fieldsOf: the tools of before see exactly what they saw', () => {
  // Bash: stdout\nstderr; a string as is; Write/Edit (an object without stdout) — "\n", even when it has content.
  assert.strictEqual(outOf('Bash', { stdout: 'a', stderr: 'b', interrupted: false }), 'a\nb');
  assert.strictEqual(outOf('Bash', 'plain'), 'plain');
  assert.strictEqual(outOf('Write', { type: 'create', filePath: '/x', content: 'текст файла' }), '\n');
  assert.strictEqual(outOf('Edit', { filePath: '/x', oldString: 'a', newString: 'b' }), '\n');
  assert.strictEqual(outOf('NotebookEdit', [{ type: 'text', text: 'x' }]), '\n');
  assert.strictEqual(outOf('Write', 'The file /x has been updated'), 'The file /x has been updated');
});

test('fieldsOf: tool, cmd, path, body of the new tools — as before (input as JSON)', () => {
  const f = hot.fieldsOf({ tool_name: 'Agent', tool_input: { description: 'd', prompt: 'проверь браузер', subagent_type: 'x' }, tool_response: {} }, { withOut: true });
  assert.strictEqual(f.tool, 'Agent');
  assert.strictEqual(f.cmd, '');
  assert.strictEqual(f.path, '');
  assert.match(f.body, /проверь браузер/);
});

// Through the runner, as Claude Code calls it once the matcher lets the tool in.
const lesson = (id, when, first) => ['---', `id: ${id}`, 'kind: rule', 'when:', ...when.flatMap((w) => Object.entries(w).map(([k, v], j) => `${j ? '    ' : '  - '}${k}: ${v}`)),
  'keys: []', 'status: active', 'supersedes: []', 'source: модель', 'created: 2026-10-01', '---', first, 'Вторая строка урока.', ''].join('\n');

function setup() {
  const hub = mkdtemp('memory-mcp-');
  fs.cpSync(PLUGIN, path.join(hub, 'plugin'), { recursive: true, filter: (src) => !/\.test\.cjs$/.test(src) });
  const proj = path.join(hub, 'projects', 'demo');
  const mem = path.join(proj, 'memory');
  const wt = path.join(proj, 'worktrees', 'K-1');
  fs.mkdirSync(wt, { recursive: true });
  write(path.join(mem, 'errors-index.md'), '# Индекс\n');
  write(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['delivery', 'memory'] }));
  write(path.join(mem, 'lessons', 'task-view.md'), lesson('task-view', [{ tool: '^mcp__(claude-in-chrome|Claude_Browser)__get_page_text$', out: '\\bK-\\d{3}\\b' }],
    'Задачу трекера — скриншотом, не текстом страницы.'));
  write(path.join(mem, 'lessons', 'qa-agent.md'), lesson('qa-agent', [{ tool: '^(Agent|Task)$', out: 'ERR_CONNECTION_RESET' }], 'Сброс соединения на стенде — память фронта, не регресс.'));
  write(path.join(mem, 'lessons', 'tracker-first.md'), lesson('tracker-first', [{ tool: 'tracker_issue$' }], 'Задачу — целиком, с комментариями и связями.'));
  store.ensureTriggers(mem);
  return { hub, plugin: path.join(hub, 'plugin'), wt, logs: mkdtemp('memory-mcp-logs-') };
}
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HUB_|AI_DEV_HUB|CLAUDE_PLUGIN|GIT_)/.test(k)));
function run(s, event, ev) {
  const r = spawnSync(process.execPath, [path.join(s.plugin, 'hooks', 'run.cjs'), event], {
    input: JSON.stringify({ hook_event_name: event, session_id: 's1', permission_mode: 'default', cwd: s.wt, ...ev }),
    encoding: 'utf8', timeout: 20000, env: { ...baseEnv(), AI_DEV_HUB: s.hub, HUB_LOG_DIR: s.logs, CLAUDE_PLUGIN_ROOT: s.plugin } });
  let json = null;
  try { json = r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null; } catch { /* plain */ }
  return ((json && json.hookSpecificOutput) || {}).additionalContext || '';
}

test('runner: a lesson on the output of a browser MCP call, of an agent report, on a tracker call comes after it', () => {
  const s = setup();
  run(s, 'SessionStart', { source: 'startup' });
  const page = run(s, 'PostToolUse', { tool_name: 'mcp__claude-in-chrome__get_page_text', tool_use_id: 't1', tool_input: { tabId: 1 },
    tool_response: [{ type: 'text', text: 'Трекер: K-123 «Починить вход»' }] });
  assert.match(page, /Урок памяти \(task-view\)/);
  const agent = run(s, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 't2', tool_input: { description: 'qa', prompt: 'проверь стенд', subagent_type: 'x' },
    tool_response: { status: 'completed', content: [{ type: 'text', text: 'Стенд отдал ERR_CONNECTION_RESET дважды' }] } });
  assert.match(agent, /Урок памяти \(qa-agent\)/);
  const tracker = run(s, 'PostToolUse', { tool_name: 'mcp__plugin_studio-skills_tracker__tracker_issue', tool_use_id: 't3', tool_input: { key: 'K-1' },
    tool_response: [{ type: 'text', text: '{"summary":"x"}' }] });
  assert.match(tracker, /Урок памяти \(tracker-first\)/);
  const quiet = run(s, 'PostToolUse', { tool_name: 'mcp__claude-in-chrome__get_page_text', tool_use_id: 't4', tool_input: { tabId: 1 },
    tool_response: [{ type: 'text', text: 'страница без номера задачи' }] });
  assert.doesNotMatch(quiet, /Урок памяти/);
});
