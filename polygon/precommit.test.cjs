// node --test polygon/precommit.test.cjs — проверка pre-commit.d/20-polygon.sh во временном репозитории из HEAD:
// main = HEAD, коммит правит базу хаба; хуже main — отказ, не хуже — проход; без ~/hub-data — строка о пропуске.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, '.githooks', 'pre-commit.d', '20-polygon.sh');

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'polygon-precommit-'));
  execFileSync('tar', ['-x', '-C', d], { input: execFileSync('git', ['-C', ROOT, 'archive', 'HEAD'], { maxBuffer: 256 * 1024 * 1024 }) });
  const git = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'eval@example.test'); git('config', 'user.name', 'eval'); git('config', 'commit.gpgsign', 'false');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'slice');
  // The script under test is the working copy one: a red test before the file exists.
  if (fs.existsSync(SCRIPT)) {
    fs.mkdirSync(path.join(d, '.githooks', 'pre-commit.d'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(d, '.githooks', 'pre-commit.d', '20-polygon.sh'));
  }
  return { d, git };
}
const hook = (d, env = {}) => spawnSync('bash', [path.join(d, '.githooks', 'pre-commit.d', '20-polygon.sh')], { cwd: d, encoding: 'utf8',
  timeout: 120000, env: { ...process.env, HUB_DATA: path.join(d, 'no-hub-data'), ...env } });

// Real `git commit` from a worktree, through a minimal pre-commit.d runner (as slice 02's): git hands its hooks
// GIT_DIR and GIT_INDEX_FILE, and the fixtures' `git -C` must not write into the hub repo with them (review 05.11).
function worktreeRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'polygon-precommit-wt-'));
  const main = path.join(d, 'main');
  fs.mkdirSync(main);
  execFileSync('tar', ['-x', '-C', main], { input: execFileSync('git', ['-C', ROOT, 'archive', 'HEAD'], { maxBuffer: 256 * 1024 * 1024 }) });
  if (fs.existsSync(SCRIPT)) fs.copyFileSync(SCRIPT, path.join(main, '.githooks', 'pre-commit.d', '20-polygon.sh'));
  fs.writeFileSync(path.join(main, '.githooks', 'pre-commit'),
    '#!/usr/bin/env bash\nfor c in "$(dirname "$0")"/pre-commit.d/*; do [ -x "$c" ] || continue; "$c" || exit 1; done\n', { mode: 0o755 });
  const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'real@user.test'); git(main, 'config', 'user.name', 'real'); git(main, 'config', 'commit.gpgsign', 'false');
  git(main, 'config', 'core.hooksPath', '.githooks');
  git(main, 'add', '-A'); git(main, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const wt = path.join(d, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'slice', wt);
  const commit = (msg) => spawnSync('git', ['-C', wt, 'commit', '-q', '-m', msg], { encoding: 'utf8', timeout: 120000,
    env: { ...process.env, HUB_DATA: path.join(d, 'no-hub-data') } });
  const state = () => ({ email: git(main, 'config', 'user.email'), bare: git(main, 'config', '--get', 'core.bare'),
    branches: git(main, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort(),
    worktrees: git(main, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length,
    wtBranch: git(wt, 'rev-parse', '--abbrev-ref', 'HEAD') });
  return { main, wt, git, commit, state };
}

test('20-polygon под настоящим git commit из worktree: коммит проходит, репозиторий хаба цел', () => {
  const { wt, git, commit, state } = worktreeRepo();
  const before = state();
  fs.appendFileSync(path.join(wt, 'plugin', 'agents', 'tester.md'), '\n');
  git(wt, 'add', 'plugin/agents/tester.md');
  const r = commit('tester: строка');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /polygon: no check worse than main/);
  assert.deepStrictEqual(state(), before, 'фикстуры полигона не трогают репозиторий хаба');
  assert.strictEqual(git(wt, 'log', '-1', '--format=%s'), 'tester: строка');
});

test('20-polygon под настоящим git commit: регрессия — отказ, репозиторий хаба цел', () => {
  const { wt, git, commit, state } = worktreeRepo();
  const before = state();
  const f = path.join(wt, 'plugin', 'hooks', 'base-rules.json');
  fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8')).filter((x) => x.id !== 'push'), null, 2) + '\n');
  git(wt, 'add', 'plugin/hooks/base-rules.json');
  const r = commit('rules: без push');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /H03\/push: 1\/1 → 0\/1/);
  assert.deepStrictEqual(state(), before);
});

test('20-polygon: правка базы без регрессии — проход, время и строка о пропуске реальных корпусов', () => {
  assert.ok(fs.existsSync(SCRIPT), 'нет .githooks/pre-commit.d/20-polygon.sh');
  const { d, git } = repo();
  fs.appendFileSync(path.join(d, 'plugin', 'agents', 'tester.md'), '\n');
  git('add', 'plugin/agents/tester.md');
  const r = hook(d);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /реальные корпуса пропущены/);
  assert.match(r.stdout + r.stderr, /polygon: .*\d+(\.\d)? s/);
});

test('20-polygon: проверка стала хуже main — отказ со строкой сравнения', () => {
  assert.ok(fs.existsSync(SCRIPT), 'нет .githooks/pre-commit.d/20-polygon.sh');
  const { d, git } = repo();
  const f = path.join(d, 'plugin', 'hooks', 'base-rules.json');
  fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8')).filter((r) => r.id !== 'push'), null, 2) + '\n');
  git('add', 'plugin/hooks/base-rules.json');
  const r = hook(d);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /-\s+H03\/push: 1\/1 → 0\/1/);
});

test('20-polygon: коммит без базы хаба и полигона — полигон не гоняется', () => {
  assert.ok(fs.existsSync(SCRIPT), 'нет .githooks/pre-commit.d/20-polygon.sh');
  const { d, git } = repo();
  fs.appendFileSync(path.join(d, 'README.md'), '\n');
  git('add', 'README.md');
  const r = hook(d);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /реальные корпуса/);
});
