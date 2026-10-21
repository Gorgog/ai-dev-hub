// node --test guard.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide } = require('./guard.cjs');

function project(grants) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gd-')), 'projects', 'demo');
  fs.mkdirSync(path.join(p, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(p, 'dispatch-rules.json'), JSON.stringify({
    heavy: [{ name: 'e2e', tools: '^Bash$', commands: 'jest' }],
    medium: [{ name: 'browser', tools: '^mcp__claude-in-chrome__' }],
  }));
  if (grants) fs.writeFileSync(path.join(p, 'memory', 'dispatch-grants.json'), JSON.stringify(grants));
  return p;
}
const ev = (p, tool, command) => ({ cwd: path.join(p, 'worktrees', 'K-1'), tool_name: tool, tool_input: { command } });

test('decide: outside worktrees and on light calls — allow', () => {
  const p = project();
  assert.strictEqual(decide({ cwd: path.join(p, 'repo'), tool_name: 'Bash', tool_input: { command: 'npx jest' } }), null);
  assert.strictEqual(decide(ev(p, 'Bash', 'git status')), null);
});

test('decide: heavy without a grant — blocked with a reason, journaled', () => {
  const p = project();
  const r = decide(ev(p, 'Bash', 'npx jest x'));
  assert.match(r.reason, /Заблокировано замком диспетчера: «e2e»/);
  assert.match(fs.readFileSync(path.join(p, 'memory', 'dispatch-guard.log'), 'utf8'), /"decision":"blocked"/);
});

test('decide: a valid grant passes; heavy covers medium; another holder or expiry blocks', () => {
  const soon = new Date(Date.now() + 600000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(decide(ev(project({ heavy: { holder: 'K-1', until: soon } }), 'Bash', 'npx jest')), null);
  assert.strictEqual(decide(ev(project({ heavy: { holder: 'K-1', until: soon } }), 'mcp__claude-in-chrome__navigate')), null);
  assert.ok(decide(ev(project({ heavy: { holder: 'K-2', until: soon } }), 'Bash', 'npx jest')));
  assert.ok(decide(ev(project({ heavy: { holder: 'K-1', until: past } }), 'Bash', 'npx jest')));
});
