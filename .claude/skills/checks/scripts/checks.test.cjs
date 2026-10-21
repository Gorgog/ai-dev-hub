// node --test checks.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { findConfig, matchGlob, ownFiles, selectFiles, render, filterOwn, runSteps, summarize } = require('./checks.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'checks-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

test('findConfig walks up to projects/<name>/checks.json from a worktree subfolder', () => {
  const hub = tmp();
  write(path.join(hub, 'projects', 'demo', 'checks.json'), '{"fast":[]}');
  const deep = path.join(hub, 'projects', 'demo', 'worktrees', 'K-1', 'apps', 'web');
  fs.mkdirSync(deep, { recursive: true });
  const c = findConfig(deep);
  assert.strictEqual(c.file, path.join(hub, 'projects', 'demo', 'checks.json'));
  assert.strictEqual(c.project, 'demo');
  assert.strictEqual(findConfig(os.tmpdir()), null);
});

test('matchGlob understands **, * and {a,b}', () => {
  const g = 'apps/frontend/**/*.{ts,tsx}';
  assert.ok(matchGlob('apps/frontend/src/a/b.tsx', g));
  assert.ok(matchGlob('apps/frontend/x.ts', g));
  assert.ok(!matchGlob('apps/backend/x.ts', g));
  assert.ok(!matchGlob('apps/frontend/src/a.css', g));
  assert.ok(matchGlob('anything/at/all.md', undefined));
});

test('ownFiles: committed on the branch, modified and untracked; deleted files left out', () => {
  const r = tmp();
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  write(path.join(r, 'keep.ts'), '1'); write(path.join(r, 'gone.ts'), '1'); write(path.join(r, 'base.ts'), '1');
  git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'base');
  git(r, 'switch', '-q', '-c', 'K-1');
  write(path.join(r, 'committed.ts'), '2'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'work');
  write(path.join(r, 'keep.ts'), '3');
  write(path.join(r, 'new', 'untracked.ts'), '4');
  fs.unlinkSync(path.join(r, 'gone.ts'));
  assert.deepStrictEqual(ownFiles(r, 'main').sort(), ['committed.ts', 'keep.ts', 'new/untracked.ts']);
});

test('selectFiles keeps the glob and makes paths relative to the step cwd', () => {
  const files = ['apps/frontend/src/a.tsx', 'apps/backend/b.ts', 'README.md'];
  assert.deepStrictEqual(selectFiles(files, { cwd: 'apps/frontend', glob: 'apps/frontend/**/*.tsx' }), ['src/a.tsx']);
  assert.deepStrictEqual(selectFiles(files, {}), files);
});

test('render quotes {files} and fills {scratch}', () => {
  assert.strictEqual(render('fmt {files} --cache {scratch}/x', { files: ['a b.ts', 'c.ts'], scratch: 'S' }),
    'fmt "a b.ts" "c.ts" --cache S/x');
});

test('filterOwn keeps only lines about own files, whatever the slash', () => {
  const out = ['src/a.tsx(3,1): error TS1', 'src\\other.ts(1,1): error TS2', 'src\\b.ts(9,9): error TS3', 'Found 3 errors'].join('\n');
  assert.deepStrictEqual(filterOwn(out, ['src/a.tsx', 'src/b.ts']), ['src/a.tsx(3,1): error TS1', 'src\\b.ts(9,9): error TS3']);
});

test('runSteps: no own files -> SKIP, failing command -> FAIL, filterOwn ignores background errors', () => {
  const r = tmp();
  const scratch = tmp();
  const files = ['src/a.ts'];
  const steps = [
    { name: 'none', glob: '**/*.css', cmd: 'node -e "process.exit(1)" {files}' },
    { name: 'bad', cmd: 'node -e "console.log(\'boom\');process.exit(3)"' },
    { name: 'bg', filterOwn: true, cmd: 'node -e "console.log(\'src/zzz.ts(1,1): error\');process.exit(2)"' },
    { name: 'own', filterOwn: true, cmd: 'node -e "console.log(\'src/a.ts(1,1): error X\');process.exit(2)"' },
    { name: 'ok', cmd: 'node -e "process.exit(0)" {files}' },
  ];
  const res = runSteps(steps, { repo: r, files, scratch });
  assert.deepStrictEqual(res.map((x) => x.status), ['SKIP', 'FAIL', 'OK', 'FAIL', 'OK']);
  assert.deepStrictEqual(res[3].lines, ['src/a.ts(1,1): error X']);
  assert.ok(fs.existsSync(res[1].log));
});

test('summarize: one line per step, errors under FAIL, exit code 1 on any FAIL', () => {
  const s = summarize([
    { name: 'fmt', status: 'OK', ms: 1200, log: 'L1' },
    { name: 'tsc', status: 'FAIL', ms: 30500, log: 'L2', lines: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'] },
  ]);
  assert.strictEqual(s.code, 1);
  assert.match(s.text, /^fmt · OK · 1 с · L1$/m);
  assert.match(s.text, /^tsc · FAIL · 31 с · L2$/m);
  assert.ok(s.text.split('\n').length <= 10);
  assert.match(s.text, /^ {2}e1$/m);
  assert.doesNotMatch(s.text, /e6/);
  assert.strictEqual(summarize([{ name: 'a', status: 'SKIP', ms: 0, log: '' }]).code, 0);
});
