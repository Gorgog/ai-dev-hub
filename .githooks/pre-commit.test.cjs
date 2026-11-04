// node --test .githooks/pre-commit.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOKS = __dirname;
// A test run from inside a git hook inherits GIT_DIR, GIT_INDEX_FILE and friends: they would point at the hub.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// A hub in miniature: this branch's .githooks committed, core.hooksPath relative as sync-claude.sh sets it, the
// private list untracked in the main copy only, and a worktree beside it - as the hub's slices are.
function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const main = path.join(tmp, 'main');
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t'); git(main, 'config', 'user.name', 't');
  fs.cpSync(path.join(HOOKS, 'pre-commit'), path.join(main, '.githooks', 'pre-commit'));
  const dir = path.join(HOOKS, 'pre-commit.d');
  if (fs.existsSync(dir)) fs.cpSync(dir, path.join(main, '.githooks', 'pre-commit.d'), { recursive: true });
  write(path.join(main, 'README.md'), 'base\n');
  git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'config', 'core.hooksPath', '.githooks');
  write(path.join(main, '.githooks', 'private-patterns'), '# names\n\nsecretclient\nTASK-[0-9]+\n');
  git(main, 'worktree', 'add', '-q', '-b', 'slice', wt);
  return { main, wt, list: path.join(main, '.githooks', 'private-patterns') };
}

// Stages one new file and tries to commit it; returns the commit's exit code and stderr.
function commit(cwd, name, text) {
  write(path.join(cwd, name), text);
  git(cwd, 'add', '--', name);
  const r = spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd, encoding: 'utf8', env });
  return { status: r.status, err: r.stderr };
}

test('pre-commit: a line from the list blocks the commit in the worktree and in the main copy', (t) => {
  const { main, wt } = setup(t);
  for (const cwd of [wt, main]) {
    const r = commit(cwd, 'notes file.md', 'clean line\nwork for SecretClient\n');
    assert.notStrictEqual(r.status, 0, `${cwd}: commit passed\n${r.err}`);
    assert.match(r.err, /notes file\.md/, cwd);
    assert.match(r.err, /SecretClient/, cwd);
    assert.match(r.err, /10-private-patterns\.sh/, cwd);
  }
});

test('pre-commit: a clean commit passes in the worktree, silently', (t) => {
  const { wt } = setup(t);
  const r = commit(wt, 'a.md', 'nothing private here, task-x\n');
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.err, '');
});

test('pre-commit: no list - a line says the check is skipped, the commit passes', (t) => {
  const { wt, list } = setup(t);
  fs.rmSync(list);
  const r = commit(wt, 'a.md', 'secretclient\n');
  assert.strictEqual(r.status, 0, r.err);
  assert.match(r.err, /list not found.*check skipped/);
});

test('pre-commit: a list of comments only - a line says the check is skipped', (t) => {
  const { wt, list } = setup(t);
  fs.writeFileSync(list, '# only a comment\n\n');
  const r = commit(wt, 'a.md', 'secretclient\n');
  assert.strictEqual(r.status, 0, r.err);
  assert.match(r.err, /list is empty.*check skipped/);
});

test('pre-commit: a check in pre-commit.d exiting 1 blocks the commit with its name', (t) => {
  const { main, wt } = setup(t);
  // The worktree runs its own checked-out .githooks: the failing check goes there.
  const f = path.join(wt, '.githooks', 'pre-commit.d', '50-always-fails.sh');
  write(f, '#!/usr/bin/env bash\nexit 1\n');
  fs.chmodSync(f, 0o755);
  const r = commit(wt, 'a.md', 'clean\n');
  assert.notStrictEqual(r.status, 0, r.err);
  assert.match(r.err, /50-always-fails\.sh/);
  assert.ok(!fs.existsSync(path.join(main, '.githooks', 'pre-commit.d', '50-always-fails.sh')));
});

// Regression (review, round 1): the runner fed its list of checks on stdin, a check that read stdin ate the rest
// of it, and the later checks silently did not run.
test('pre-commit: a check reading stdin does not stop the checks after it', (t) => {
  const { wt } = setup(t);
  const d = path.join(wt, '.githooks', 'pre-commit.d');
  write(path.join(d, '20-reads-stdin.sh'), '#!/usr/bin/env bash\ncat >/dev/null\n');
  write(path.join(d, '30-fails.sh'), '#!/usr/bin/env bash\necho ran-30 >&2\nexit 1\n');
  for (const n of ['20-reads-stdin.sh', '30-fails.sh']) fs.chmodSync(path.join(d, n), 0o755);
  const r = commit(wt, 'a.md', 'clean\n');
  assert.notStrictEqual(r.status, 0, r.err);
  assert.match(r.err, /ran-30/);
  assert.match(r.err, /30-fails\.sh/);
});

// Regression (review, round 1): with .git a file (--separate-git-dir) the common dir is not inside the main copy;
// the main copy's own list must still block, as the old hook did through --show-toplevel.
test('pre-commit: a main copy with a separate git dir still blocks a line from its list', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-sep-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const main = path.join(tmp, 'main');
  git(tmp, 'init', '-q', '-b', 'main', '--separate-git-dir', path.join(tmp, 'store.git'), main);
  git(main, 'config', 'user.email', 't@t'); git(main, 'config', 'user.name', 't');
  fs.cpSync(path.join(HOOKS, 'pre-commit'), path.join(main, '.githooks', 'pre-commit'));
  fs.cpSync(path.join(HOOKS, 'pre-commit.d'), path.join(main, '.githooks', 'pre-commit.d'), { recursive: true });
  git(main, 'config', 'core.hooksPath', '.githooks');
  write(path.join(main, '.githooks', 'private-patterns'), 'secretclient\n');
  const r = commit(main, 'a.md', 'secretclient\n');
  assert.notStrictEqual(r.status, 0, r.err);
  assert.match(r.err, /private pattern in a\.md/);
});

test('pre-commit: checks run in name order; a non-executable file is not a check', (t) => {
  const { wt } = setup(t);
  const d = path.join(wt, '.githooks', 'pre-commit.d');
  for (const n of ['30-b.sh', '20-a.sh']) {
    write(path.join(d, n), `#!/usr/bin/env bash\necho ran ${n} >&2\n`);
    fs.chmodSync(path.join(d, n), 0o755);
  }
  write(path.join(d, 'README.md'), 'exit 1\n');
  const r = commit(wt, 'a.md', 'clean\n');
  assert.strictEqual(r.status, 0, r.err);
  assert.match(r.err, /ran 20-a\.sh\nran 30-b\.sh/);
});
