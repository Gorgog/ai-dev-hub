// node --test rules-guard.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findProject, loadRules, evaluate, toHookOutput } = require('./rules-guard.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rg-'));
const SHIPPED = path.join(__dirname, 'base-rules.json');
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });

test('findProject: only projects/<name> of THIS hub — repo, worktree, project folder; not any …/projects/x', () => {
  const hub = 'W:/hub';
  assert.deepStrictEqual(findProject('W:\\hub\\projects\\demo\\repo\\apps\\web', hub), { dir: 'W:/hub/projects/demo', name: 'demo' });
  assert.deepStrictEqual(findProject('w:/HUB/projects/demo/worktrees/K-1', hub), { dir: 'W:/hub/projects/demo', name: 'demo' });
  assert.deepStrictEqual(findProject('W:/hub/projects/demo', hub), { dir: 'W:/hub/projects/demo', name: 'demo' });
  assert.strictEqual(findProject('C:/Users/u/projects/app', hub), null);
  assert.strictEqual(findProject('W:/hub/projects/demo/repo/apps/x/projects/y', hub).name, 'demo');
  assert.strictEqual(findProject('W:/hub', hub), null);
});

test('shipped base-rules.json: catches the forms the hub itself advises and leaves look-alikes alone', () => {
  const { rules, warnings } = loadRules(SHIPPED, null);
  assert.deepStrictEqual(warnings, []);
  const hit = (ev) => evaluate(ev, rules).hits.map((h) => h.id);
  const cases = [
    [bash('cd /w/repo && git status'), ['cd-no-subshell']],
    [bash('ls && cd x && make'), ['cd-no-subshell']],
    [bash('( cd /w/repo && git status )'), []],
    [ps('(cd W:/x; npm test)'), ['cd-powershell']],
    [ps('Set-Location W:/x'), ['cd-powershell']],
    [bash('git add -A apps/frontend'), ['git-add-all']],
    [bash('git -C repo add -A'), ['git-add-all']],
    [bash('git add apps/frontend/src/a.ts'), []],
    [bash('git -C repo checkout -- .'), ['checkout-dot']],
    [bash('git checkout -- apps/a.ts'), []],
    [bash('git -C repo worktree remove --force wt'), ['worktree-force']],
    [bash('git clean -fdx'), ['clean-x']],
    [bash('git clean -f -x'), ['clean-x']],
    [bash('git -C W:/ai-dev-hub clean -fdx'), ['clean-x']],
    [bash('git clean -fd'), []],
    [bash('git push -u origin K-1'), ['push']],
    [bash('git -C /w/repo push -o ci.skip'), ['push']],
    [bash('git push origin K\ngit stash pop'), ['push']],
    [bash('git push -u origin K-1-stash'), ['push']],
    [bash('git stash push -m x'), []],
    [bash('git commit -m "fix push rule"'), []],
    [bash('git config push.default current'), []],
    [bash('git log --oneline | grep push'), []],
    [bash("sed -i 's/a/b/' f.md"), ['sed-in-place']],
    [bash("sed -Ei 's/a/b/' f.md"), ['sed-in-place']],
    [bash('sed -e s/a/b/ -i f'), ['sed-in-place']],
    [bash('sed -n 1,5p f'), []],
    [{ tool_name: 'Write', tool_input: { file_path: 'W:/x/repo/.claude/agent-memory/r.md', content: 'x' } }, ['agent-memory-write']],
    [{ tool_name: 'Edit', tool_input: { file_path: 'W:/x/memory/errors-index.md', new_string: 'не писать в .claude/agent-memory/' } }, []],
  ];
  for (const [ev, ids] of cases) assert.deepStrictEqual(hit(ev), ids, ev.tool_input.command || ev.tool_input.file_path);
});

test('loadRules: project rules add to base, modes raise or lower a rule; broken input is a warning, never silence', () => {
  const p = tmp();
  fs.writeFileSync(path.join(p, 'rules.json'), JSON.stringify({
    rules: [{ id: 'prisma-format', tools: '^Bash$', commands: 'prisma\\s+format', text: 'поля руками + validate' }],
    modes: { 'cd-no-subshell': 'deny', push: 'log' },
  }));
  const { rules, warnings } = loadRules(SHIPPED, p);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(evaluate(bash('cd x'), rules).decision, 'deny');
  assert.strictEqual(evaluate(bash('git push'), rules).decision, 'log');
  assert.strictEqual(evaluate(bash('npx prisma format'), rules).hits[0].id, 'prisma-format');

  fs.writeFileSync(path.join(p, 'rules.json'), '{ broken');
  assert.match(loadRules(SHIPPED, p).warnings[0], /rules\.json/);

  fs.writeFileSync(path.join(p, 'rules.json'), JSON.stringify({ rules: [{ id: 'bad', commands: '(' , text: 't' }], modes: { 'cd-no-subshell': 'block' } }));
  const w = loadRules(SHIPPED, p);
  assert.ok(w.warnings.some((s) => /bad/.test(s)), 'broken regex is reported');
  assert.ok(w.warnings.some((s) => /block/.test(s)), 'unknown mode is reported');
  assert.strictEqual(evaluate(bash('cd x && git push'), w.rules).decision, 'ask', 'an unknown mode falls back to log and does not swallow ask');

  fs.writeFileSync(path.join(p, 'rules.json'), JSON.stringify([{ id: 'arr', commands: 'zzz', text: 't' }]));
  const arr = loadRules(SHIPPED, p);
  assert.ok(arr.rules.some((r) => r.id === 'arr'), 'an array is read as a list of rules');
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
