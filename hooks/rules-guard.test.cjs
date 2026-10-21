// node --test rules-guard.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findProject, loadRules, evaluate, toHookOutput } = require('./rules-guard.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rg-'));
const BASE = [
  { id: 'cd-no-subshell', tools: '^(Bash|PowerShell)$', commands: '^\\s*cd\\s', text: 'cd только в подоболочке' },
  { id: 'push', tools: '^Bash$', commands: '\\bgit\\b[^|;&]*\\bpush\\b', text: 'вид пуша решает пользователь', mode: 'ask' },
  { id: 'agent-memory-write', tools: '^(Edit|Write)$', input: 'agent-memory', text: 'не писать в agent-memory' },
];
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('findProject: repo, worktree and project folder of the hub; nothing outside', () => {
  assert.deepStrictEqual(findProject('W:\\hub\\projects\\demo\\repo\\apps\\web'), { dir: 'W:/hub/projects/demo', name: 'demo' });
  assert.deepStrictEqual(findProject('W:/hub/projects/demo/worktrees/K-1'), { dir: 'W:/hub/projects/demo', name: 'demo' });
  assert.deepStrictEqual(findProject('W:/hub/projects/demo'), { dir: 'W:/hub/projects/demo', name: 'demo' });
  assert.strictEqual(findProject('C:/games/rubezh'), null);
});

test('evaluate: a new rule defaults to log; the strongest mode wins', () => {
  const r1 = evaluate(bash('cd /w/x && ls'), BASE);
  assert.strictEqual(r1.decision, 'log');
  assert.deepStrictEqual(r1.hits.map((h) => h.id), ['cd-no-subshell']);
  const r2 = evaluate(bash('cd /w/x && git push -u origin K-1'), BASE);
  assert.strictEqual(r2.decision, 'ask');
  assert.strictEqual(evaluate(bash('( cd /w/x && ls )'), BASE).decision, null);
  assert.strictEqual(evaluate({ tool_name: 'Write', tool_input: { file_path: 'repo/.claude/agent-memory/r.md' } }, BASE).decision, 'log');
});

test('loadRules: project rules add to base, project modes raise or lower a rule, broken JSON is a warning', () => {
  const p = tmp();
  const baseFile = path.join(p, 'base.json');
  fs.writeFileSync(baseFile, JSON.stringify(BASE));
  fs.writeFileSync(path.join(p, 'rules.json'), JSON.stringify({
    rules: [{ id: 'prisma-format', tools: '^Bash$', commands: 'prisma\\s+format', text: 'поля руками + validate' }],
    modes: { 'cd-no-subshell': 'deny', push: 'log' },
  }));
  const { rules, warnings } = loadRules(baseFile, p);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(evaluate(bash('cd x'), rules).decision, 'deny');
  assert.strictEqual(evaluate(bash('git push'), rules).decision, 'log');
  assert.strictEqual(evaluate(bash('npx prisma format'), rules).hits[0].id, 'prisma-format');
  fs.writeFileSync(path.join(p, 'rules.json'), '{ broken');
  const bad = loadRules(baseFile, p);
  assert.strictEqual(bad.rules.length, BASE.length);
  assert.match(bad.warnings[0], /rules\.json/);
});

test('toHookOutput: deny and ask decide, log only adds context, nothing — no output', () => {
  const deny = toHookOutput({ decision: 'deny', hits: [{ id: 'a', mode: 'deny', text: 'нельзя' }] }, []);
  assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /a: нельзя/);
  const ask = toHookOutput({ decision: 'ask', hits: [{ id: 'push', mode: 'ask', text: 'спроси' }] }, []);
  assert.strictEqual(ask.hookSpecificOutput.permissionDecision, 'ask');
  const log = toHookOutput({ decision: 'log', hits: [{ id: 'cd', mode: 'log', text: 'подоболочка' }] }, []);
  assert.strictEqual(log.hookSpecificOutput.permissionDecision, undefined);
  assert.match(log.hookSpecificOutput.additionalContext, /cd: подоболочка/);
  assert.strictEqual(toHookOutput({ decision: null, hits: [] }, []), null);
  const warn = toHookOutput({ decision: null, hits: [] }, ['rules.json не читается']);
  assert.match(warn.hookSpecificOutput.additionalContext, /rules\.json/);
});
