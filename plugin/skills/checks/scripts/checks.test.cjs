// node --test checks.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { findConfig, matchGlob, ownFiles, selectFiles, render, filterOwn, runSteps, summarize, baselineRefusal } = require('./checks.cjs');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const hasSystemd = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0;
// A process whose argv[0] is the marker (exec -a): the shell command lines that launch it merely mention it.
const alive = (marker) => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).some((pid) => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] === marker; } catch { return false; }
});
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

test('render quotes {files} and fills {scratch}, {hub}, {project}', () => {
  assert.strictEqual(render('fmt {files} --cache {scratch}/x', { files: ['a b.ts', 'c.ts'], scratch: 'S' }),
    'fmt "a b.ts" "c.ts" --cache S/x');
  assert.strictEqual(render('node {project}/memory/snippets/fmt.cjs --hub {hub} {files}',
    { files: ['a.ts'], hub: '/home/u/hub', project: '/home/u/hub/projects/demo' }),
  'node /home/u/hub/projects/demo/memory/snippets/fmt.cjs --hub /home/u/hub "a.ts"');
});

test('filterOwn keeps only lines about own files', () => {
  const out = ['src/a.tsx(3,1): error TS1', 'src/other.ts(1,1): error TS2', 'src/b.ts(9,9): error TS3', 'Found 3 errors'].join('\n');
  assert.deepStrictEqual(filterOwn(out, ['src/a.tsx', 'src/b.ts']), ['src/a.tsx(3,1): error TS1', 'src/b.ts(9,9): error TS3']);
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

test('failOn: exit 0 with a failure line in the output is a FAIL (runners that lie with their exit code)', () => {
  const r = tmp();
  const res = runSteps([
    { name: 'lies', failOn: 'Tests\\s+\\d+ failed', cmd: 'node -e "console.log(\'Tests  2 failed | 10 passed\')"' },
    { name: 'honest', failOn: 'Tests\\s+\\d+ failed', cmd: 'node -e "console.log(\'Tests  12 passed\')"' },
  ], { repo: r, files: [], scratch: tmp() });
  assert.deepStrictEqual(res.map((x) => x.status), ['FAIL', 'OK']);
  assert.deepStrictEqual(res[0].lines, ['Tests  2 failed | 10 passed']);
});

test('okOn: a success line beats a noisy non-zero exit, but not a failOn line', () => {
  const r = tmp();
  const step = (out, code) => ({ name: 'v', okOn: 'Tests\\s+\\d+ passed', failOn: 'Tests\\s+\\d+ failed',
    cmd: `node -e "console.log('${out}');process.exit(${code})"` });
  const res = runSteps([step('Tests  10 passed', 1), step('Tests  1 failed | 9 passed', 1), step('crash', 1),
    step('\\x1b[2m      Tests \\x1b[22m \\x1b[1m\\x1b[32m10 passed\\x1b[39m', 1)],
    { repo: r, files: [], scratch: tmp() });
  assert.deepStrictEqual(res.map((x) => x.status), ['OK', 'FAIL', 'FAIL', 'OK']);
});

test('filterOwn matches the whole path: own src/index.ts does not catch src/index.tsx', () => {
  assert.deepStrictEqual(filterOwn('src/index.tsx(1,1): error TS1\nsrc/index.ts(2,2): error TS2', ['src/index.ts']),
    ['src/index.ts(2,2): error TS2']);
});

test('filterOwn catches own files printed as absolute or ./ paths', () => {
  const out = ['./src/a.ts:1:1 - error TS1', '/home/u/x/app/src/a.ts:1:1 error', '/home/u/x/app/src/a.ts(1,1): error',
    'xsrc/a.ts(1,1): error', '/home/u/x/app/src/a.tsx(1,1): error'].join('\n');
  assert.strictEqual(filterOwn(out, ['src/a.ts']).length, 3);
});

test('baselineRefusal: the background is recorded only on a clean checkout of the base', () => {
  assert.strictEqual(baselineRefusal({ head: 'abc', base: 'abc', own: 0 }), null);
  assert.match(baselineRefusal({ head: 'abc', base: 'def', own: 0 }), /не база/);
  assert.match(baselineRefusal({ head: 'abc', base: 'abc', own: 2 }), /свои правки/);
});

test('filterOwn step: a command that did not run is a FAIL, not a silent OK', () => {
  const r = tmp();
  const res = runSteps([
    { name: 'nocwd', cwd: 'nope', filterOwn: true, cmd: 'node -e "process.exit(0)"' },
    { name: 'nocmd', filterOwn: true, cmd: 'definitely-not-a-cmd-xyz' },
    { name: 'slow', timeoutSec: 1, cmd: 'node -e "setTimeout(()=>{},5000)"' },
  ], { repo: r, files: ['src/a.ts'], scratch: tmp() });
  assert.deepStrictEqual(res.map((x) => x.status), ['FAIL', 'FAIL', 'FAIL']);
  assert.match(res[2].lines[0], /таймаут 1 с/);
});

// sh -> node -> a worker: the old spawnSync timeout killed only sh, the worker lived on.
test('timeout stops the whole tree of a step, not just the shell', () => {
  const marker = `checks-worker-${process.pid}`;
  const [res] = runSteps([{ name: 'tree', timeoutSec: 1,
    cmd: `node -e "require('child_process').spawn('bash', ['-c', 'exec -a ${marker} sleep 60'], { stdio: 'ignore' }); setTimeout(() => {}, 60000)"` }],
  { repo: tmp(), files: [], scratch: tmp() });
  assert.strictEqual(res.status, 'FAIL');
  assert.match(res.lines[0], /таймаут/);
  const end = Date.now() + 5000;
  while (alive(marker) && Date.now() < end) spawnSync('sleep', ['0.2']);
  assert.ok(!alive(marker), 'the grandchild of the step is gone');
});

test('memory: a step over its ceiling is a FAIL that says so, not a checker verdict', { skip: !hasSystemd && 'no systemd user manager' }, () => {
  const hog = 'const a = []; for (;;) a.push(Buffer.alloc(1e7, 1));';
  const res = runSteps([
    { name: 'hog', memory: '150M', okOn: '.*', cmd: `node -e "${hog}"` },
    { name: 'full-default', cmd: `node -e "${hog}"` },
  ], { repo: tmp(), files: [], scratch: tmp(), memory: '200M' });
  assert.deepStrictEqual(res.map((x) => x.status), ['FAIL', 'FAIL']);
  assert.match(res[0].lines[0], /убит: MemoryMax 150M/);
  assert.match(res[1].lines[0], /убит: MemoryMax 200M/);
  assert.match(fs.readFileSync(res[0].log, 'utf8'), /убит: MemoryMax 150M/, 'the reason is in the log too');
});

test('baseline: an error new against the recorded background fails even outside own files', () => {
  const r = tmp();
  const bdir = tmp();
  fs.writeFileSync(path.join(bdir, 'types.txt'), 'src/old.ts: error TS1: old\n');
  const step = (lines) => ({ name: 'types', filterOwn: true, baseline: true,
    cmd: `node -e "console.log(${JSON.stringify(lines.join('\n')).replace(/"/g, '\\"')});process.exit(2)"` });
  const ctx = { repo: r, files: ['src/a.ts'], scratch: tmp(), baselineDir: bdir };
  const [same] = runSteps([step(['src/old.ts(9,9): error TS1: old'])], ctx);
  const [consumer] = runSteps([step(['src/old.ts(1,1): error TS1: old', 'src/b.ts(3,3): error TS2: broke'])], ctx);
  const [own] = runSteps([step(['src/a.ts(1,1): error TS3: mine'])], ctx);
  assert.strictEqual(same.status, 'OK');
  assert.strictEqual(consumer.status, 'FAIL');
  assert.deepStrictEqual(consumer.lines, ['src/b.ts(3,3): error TS2: broke']);
  assert.strictEqual(own.status, 'FAIL');
  const [nobase] = runSteps([step(['src/b.ts(3,3): error TS2: broke'])], { ...ctx, baselineDir: tmp() });
  assert.strictEqual(nobase.status, 'WARN');
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

test('--full writes last-full.json into the git dir of the worktree: sha of HEAD, exit code, clean tree, steps', () => {
  const hub = tmp();
  const proj = path.join(hub, 'projects', 'demo');
  const r = path.join(proj, 'repo');
  fs.mkdirSync(r, { recursive: true });
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  write(path.join(r, 'a.txt'), '1'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'base');
  const cfg = path.join(proj, 'checks.json');
  const cli = () => spawnSync(process.execPath, [path.join(__dirname, 'checks.cjs'), '--full', '--base', 'main', '--config', cfg],
    { cwd: r, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: path.join(hub, 'cache') } });
  const file = git(r, 'rev-parse', '--path-format=absolute', '--git-path', 'hub/last-full.json').trim();
  const head = git(r, 'rev-parse', 'HEAD').trim();

  write(cfg, JSON.stringify({ full: [{ name: 'ok', cmd: 'true' }] }));
  assert.strictEqual(cli().status, 0);
  assert.ok(fs.existsSync(file), 'last-full.json written');
  const green = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(green.sha, head);
  assert.strictEqual(green.code, 0);
  assert.strictEqual(green.clean, true);
  assert.deepStrictEqual(green.steps, [{ name: 'ok', status: 'OK' }]);
  assert.ok(Date.parse(green.at));

  write(path.join(r, 'wip.txt'), 'x');
  write(cfg, JSON.stringify({ full: [{ name: 'ok', cmd: 'true' }, { name: 'bad', cmd: 'echo error boom; exit 1' }] }));
  assert.strictEqual(cli().status, 1);
  const red = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(red.code, 1);
  assert.strictEqual(red.clean, false);
  assert.deepStrictEqual(red.steps.map((s) => s.status), ['OK', 'FAIL']);
});

test('the fast run leaves last-full.json alone', () => {
  const hub = tmp();
  const proj = path.join(hub, 'projects', 'demo');
  const r = path.join(proj, 'repo');
  fs.mkdirSync(r, { recursive: true });
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  write(path.join(r, 'a.txt'), '1'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'base');
  write(path.join(proj, 'checks.json'), JSON.stringify({ fast: [{ name: 'ok', cmd: 'true' }] }));
  const res = spawnSync(process.execPath, [path.join(__dirname, 'checks.cjs'), '--base', 'main', '--config', path.join(proj, 'checks.json')],
    { cwd: r, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: path.join(hub, 'cache') } });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(!fs.existsSync(git(r, 'rev-parse', '--path-format=absolute', '--git-path', 'hub/last-full.json').trim()));
});

test('review 1: last-full.json keeps the HEAD of the start of the run — a commit during a background --full is not «checked»', () => {
  const hub = tmp();
  const proj = path.join(hub, 'projects', 'demo');
  const r = path.join(proj, 'repo');
  fs.mkdirSync(r, { recursive: true });
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  write(path.join(r, 'a.txt'), '1'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'base');
  const before = git(r, 'rev-parse', 'HEAD').trim();
  // The step itself commits: the same as the session committing docs while the full run goes on.
  write(path.join(proj, 'checks.json'), JSON.stringify({ full: [{ name: 'commits', cmd: 'echo x > d.md && git add d.md && git -c user.email=t@t -c user.name=t commit -q -m docs' }] }));
  const res = spawnSync(process.execPath, [path.join(__dirname, 'checks.cjs'), '--full', '--base', 'main', '--config', path.join(proj, 'checks.json')],
    { cwd: r, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: path.join(hub, 'cache') } });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.notStrictEqual(git(r, 'rev-parse', 'HEAD').trim(), before, 'the step did commit');
  const file = git(r, 'rev-parse', '--path-format=absolute', '--git-path', 'hub/last-full.json').trim();
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sha, before);
});
