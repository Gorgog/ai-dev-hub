// node --test statusline.test.cjs — the status line: проект · ветка · контекст % · кэш % · кто держит тяжёлое.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'statusline.cjs');
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture() {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-status-'));
  const proj = path.join(hub, 'projects', 'demo');
  const repo = path.join(proj, 'repo');
  fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'a');
  const wt = path.join(proj, 'worktrees', 'K-7');
  git(repo, 'worktree', 'add', '-q', '-b', 'K-7', wt);
  return { hub, proj, repo, wt };
}

const line = (fx, input) => {
  const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input), env: { ...cleanEnv(), AI_DEV_HUB: fx.hub }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const usage = (input, create, read) => ({ used_percentage: 34.4, current_usage: { input_tokens: input, output_tokens: 10, cache_creation_input_tokens: create, cache_read_input_tokens: read } });
const grants = (fx, g) => fs.writeFileSync(path.join(fx.proj, 'memory', 'dispatch-grants.json'), JSON.stringify(g));

test('a worktree of a hub project: every part, the heavy holder from the dispatcher\'s grants', () => {
  const fx = fixture();
  const until = new Date(Date.now() + 600000).toISOString();
  grants(fx, { heavy: { holder: 'K-3', what: 'e2e', since: new Date().toISOString(), until } });
  const out = line(fx, { cwd: path.join(fx.wt, 'src'), workspace: { current_dir: fx.wt }, context_window: usage(100, 900, 9000) });
  assert.strictEqual(out, 'demo · K-7 · контекст 34% · кэш 90% · тяжёлое: K-3');
});

test('free and expired grants say «свободно»; a medium holder is named too', () => {
  const fx = fixture();
  assert.match(line(fx, { workspace: { current_dir: fx.repo } }), /тяжёлое: свободно$/);
  grants(fx, { heavy: { holder: 'K-3', until: new Date(Date.now() - 1000).toISOString() } });
  assert.match(line(fx, { workspace: { current_dir: fx.repo } }), /тяжёлое: свободно$/);
  grants(fx, { medium: { holder: 'K-9', until: new Date(Date.now() + 60000).toISOString() } });
  assert.match(line(fx, { workspace: { current_dir: fx.repo } }), /среднее: K-9/);
});

test('no usage yet, no project, no git: the parts that are known, never a crash', () => {
  const fx = fixture();
  assert.strictEqual(line(fx, { workspace: { current_dir: fx.repo } }), 'demo · main · тяжёлое: свободно');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
  assert.strictEqual(line(fx, { workspace: { current_dir: outside }, context_window: usage(0, 0, 0) }), path.basename(outside));
  const r = spawnSync(process.execPath, [SCRIPT], { input: '{ broken', env: { ...cleanEnv(), AI_DEV_HUB: fx.hub }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
});

test('a broken grants file does not break the line', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.proj, 'memory', 'dispatch-grants.json'), '{ half');
  assert.match(line(fx, { workspace: { current_dir: fx.repo } }), /^demo · main/);
});
