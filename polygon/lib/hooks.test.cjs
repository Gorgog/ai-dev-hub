// node --test polygon/lib/hooks.test.cjs
// The polygon runs the hooks of hooks.json as Claude Code does — the matcher included (slice 37): empty or `*` — every
// subject; only names and `|` — an exact list; anything else — a regex WITHOUT anchors (probes P35, P37 on Claude Code
// 2.1.317). An unanchored matcher in hooks.json lets more tools in than it names, and the polygon must see that too.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEvent } = require('./hooks.cjs');

const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// A plugin whose one hook prints «hit» for the event, with the given matcher.
function plugin(event, matcher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-hooks-'));
  made.push(dir);
  const group = { hooks: [{ type: 'command', command: process.execPath, args: ['-e', 'process.stdout.write("hit")'], timeout: 10 }] };
  if (matcher !== undefined) group.matcher = matcher;
  fs.mkdirSync(path.join(dir, 'hooks'));
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { [event]: [group] } }));
  return dir;
}
const hits = (dir, event, ev) => runEvent(dir, event, ev).filter((r) => r.stdout === 'hit').length;
const tool = (tool_name) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: {} });

test('names and | only — an exact list: Task does not take TaskList, Write does not take TodoWrite', () => {
  const p = plugin('PreToolUse', 'Bash|Write|Task');
  for (const t of ['Bash', 'Write', 'Task']) assert.strictEqual(hits(p, 'PreToolUse', tool(t)), 1, t);
  for (const t of ['TaskList', 'TodoWrite', 'BashOutput', 'bash', 'xBash']) assert.strictEqual(hits(p, 'PreToolUse', tool(t)), 0, t);
});

test('a matcher with other characters — a regex without anchors, as Claude Code tests it', () => {
  const p = plugin('PreToolUse', 'Bash|Task|mcp__claude-in-chrome__.*');
  for (const t of ['Bash', 'Task', 'mcp__claude-in-chrome__computer', 'TaskList', 'BashOutput', 'xmcp__claude-in-chrome__y'])
    assert.strictEqual(hits(p, 'PreToolUse', tool(t)), 1, `${t}: the unanchored regex takes it`);
  assert.strictEqual(hits(p, 'PreToolUse', tool('Read')), 0);
});

test('an anchored regex — exactly its names', () => {
  const p = plugin('PreToolUse', '^(?:Bash|Task|mcp__claude-in-chrome__.*)$');
  for (const t of ['Bash', 'Task', 'mcp__claude-in-chrome__computer']) assert.strictEqual(hits(p, 'PreToolUse', tool(t)), 1, t);
  for (const t of ['TaskList', 'BashOutput', 'xmcp__claude-in-chrome__y']) assert.strictEqual(hits(p, 'PreToolUse', tool(t)), 0, t);
});

test('no matcher, an empty one or * — every subject', () => {
  for (const m of [undefined, '', '*']) {
    const p = plugin('PostToolUseFailure', m);
    for (const t of ['Bash', 'Read', 'TaskList']) {
      let got;
      try { got = hits(p, 'PostToolUseFailure', { ...tool(t), hook_event_name: 'PostToolUseFailure' }); } catch (e) { got = `исключение: ${e.message}`; }
      assert.strictEqual(got, 1, `${m}: ${t}`);
    }
  }
});

test('SessionStart: the source is the subject, a list of names is exact', () => {
  const p = plugin('SessionStart', 'startup|resume|clear|compact');
  for (const s of ['startup', 'compact']) assert.strictEqual(hits(p, 'SessionStart', { hook_event_name: 'SessionStart', source: s }), 1, s);
  for (const s of ['startupx', 'other']) assert.strictEqual(hits(p, 'SessionStart', { hook_event_name: 'SessionStart', source: s }), 0, s);
});
