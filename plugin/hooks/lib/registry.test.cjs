// node --test plugin/hooks/lib/registry.test.cjs
// The mechanisms registry through the hub's pre-commit: a real `git commit` in a worktree of a hub in miniature,
// with .githooks/pre-commit and pre-commit.d/30-mechanisms.sh of this branch.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

const record = (id, over = {}) => JSON.stringify({ id, event: 'PreToolUse', file: `pretool.d/10-${id}.cjs`, handler: id,
  stage: 'on', onError: 'open', failScope: 'any', state: [], reads: [], polygon: ['H01'], replaces: '—', review: '2099-01-01', ...over }, null, 2);
const MODULE = "module.exports = { id: 'x', run() { return null; } };\n";

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const main = path.join(tmp, 'main');
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t'); git(main, 'config', 'user.name', 't');
  fs.cpSync(path.join(ROOT, '.githooks', 'pre-commit'), path.join(main, '.githooks', 'pre-commit'));
  const check = path.join(ROOT, '.githooks', 'pre-commit.d', '30-mechanisms.sh');
  if (fs.existsSync(check)) fs.cpSync(check, path.join(main, '.githooks', 'pre-commit.d', '30-mechanisms.sh'));
  for (const f of fs.readdirSync(__dirname).filter((f) => !f.endsWith('.test.cjs'))) {
    fs.cpSync(path.join(__dirname, f), path.join(main, 'plugin', 'hooks', 'lib', f));
  }
  write(path.join(main, 'polygon', 'scenarios', 'H01-stop.cjs'), '// scenario\n');
  write(path.join(main, 'plugin', 'hooks', 'pretool.d', '10-a.cjs'), MODULE);
  write(path.join(main, 'plugin', 'mechanisms', 'a.json'), record('a'));
  git(main, 'add', '-A'); git(main, 'commit', '-q', '--no-verify', '-m', 'base');
  git(main, 'config', 'core.hooksPath', '.githooks');
  git(main, 'worktree', 'add', '-q', '-b', 'slice', wt);
  return wt;
}

// Writes the files, stages them, commits; the commit's exit code and stderr.
function commit(cwd, files) {
  for (const [f, s] of Object.entries(files)) write(path.join(cwd, f), s);
  git(cwd, 'add', '--', ...Object.keys(files));
  const r = spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd, encoding: 'utf8', env });
  return { status: r.status, err: r.stderr };
}

test('pre-commit 30-mechanisms: a module without a registry record is refused, with the file named', (t) => {
  const wt = setup(t);
  const r = commit(wt, { 'plugin/hooks/pretool.d/20-b.cjs': MODULE });
  assert.notStrictEqual(r.status, 0, r.err);
  assert.match(r.err, /pretool\.d\/20-b\.cjs/);
  assert.match(r.err, /30-mechanisms\.sh/);
});

test('pre-commit 30-mechanisms: a record without a polygon scenario, or with a missing module file, is refused', (t) => {
  const wt = setup(t);
  const r = commit(wt, { 'plugin/hooks/pretool.d/20-b.cjs': MODULE, 'plugin/mechanisms/b.json': record('b', { file: 'pretool.d/20-b.cjs', polygon: ['H99'] }) });
  assert.notStrictEqual(r.status, 0, r.err);
  assert.match(r.err, /H99/);
  const gone = commit(wt, { 'plugin/mechanisms/c.json': record('c', { file: 'pretool.d/30-c.cjs' }) });
  assert.notStrictEqual(gone.status, 0, gone.err);
  assert.match(gone.err, /30-c\.cjs/);
});

test('pre-commit 30-mechanisms: 10 handlers fit the budget (owner decision 05.11)', (t) => {
  const wt = setup(t);
  const files = {};
  for (const id of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    files[`plugin/hooks/pretool.d/20-${id}.cjs`] = MODULE;
    files[`plugin/mechanisms/${id}.json`] = record(id, { file: `pretool.d/20-${id}.cjs` });
  }
  const r = commit(wt, files);
  assert.strictEqual(r.status, 0, r.err);
});

test('pre-commit 30-mechanisms: more than 10 handlers or 10 state kinds is refused with the list', (t) => {
  const wt = setup(t);
  const files = {};
  for (const id of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']) {
    files[`plugin/hooks/pretool.d/20-${id}.cjs`] = MODULE;
    files[`plugin/mechanisms/${id}.json`] = record(id, { file: `pretool.d/20-${id}.cjs` });
  }
  const r = commit(wt, files);
  assert.notStrictEqual(r.status, 0, r.err);
  assert.match(r.err, /обработчик.*11/);
  assert.match(r.err, /a, b, c, d, e, f, g, h, i, j, k/);
  // One handler, eleven kinds of state.
  const wt2 = setup(t);
  const state = Array.from({ length: 11 }, (_, i) => `memory/s${i}.json`);
  const s = commit(wt2, { 'plugin/mechanisms/a.json': record('a', { state }) });
  assert.notStrictEqual(s.status, 0, s.err);
  assert.match(s.err, /состояни.*11/);
  assert.match(s.err, /memory\/s10\.json/);
});

test('pre-commit 30-mechanisms: a module in a folder of no event (typo) is refused; two records of one module too', (t) => {
  const wt = setup(t);
  const typo = commit(wt, { 'plugin/hooks/pretools.d/10-x.cjs': MODULE });
  assert.notStrictEqual(typo.status, 0, typo.err);
  assert.match(typo.err, /pretools\.d/);
  const wt2 = setup(t);
  const dup = commit(wt2, { 'plugin/mechanisms/b.json': record('b', { file: 'pretool.d/10-a.cjs' }) });
  assert.notStrictEqual(dup.status, 0, dup.err);
  assert.match(dup.err, /pretool\.d\/10-a\.cjs.*a\.json.*b\.json|pretool\.d\/10-a\.cjs.*b\.json.*a\.json/);
});

test('pre-commit 30-mechanisms: an expired review date warns and lets the commit through', (t) => {
  const wt = setup(t);
  const r = commit(wt, { 'plugin/mechanisms/a.json': record('a', { review: '2020-01-01' }) });
  assert.strictEqual(r.status, 0, r.err);
  assert.match(r.err, /пересмотр.*2020-01-01/);
});

test('pre-commit 30-mechanisms: a valid registry passes silently; a commit outside hooks and the registry is not checked', (t) => {
  const wt = setup(t);
  const ok = commit(wt, { 'plugin/hooks/pretool.d/20-b.cjs': MODULE, 'plugin/mechanisms/b.json': record('b', { file: 'pretool.d/20-b.cjs' }) });
  assert.strictEqual(ok.status, 0, ok.err);
  assert.strictEqual(ok.err, '');
  // A broken module left in the working tree, unstaged: the check reads the index, the commit of a README passes.
  write(path.join(wt, 'plugin', 'hooks', 'pretool.d', '90-wip.cjs'), MODULE);
  const other = commit(wt, { 'README.md': 'x\n' });
  assert.strictEqual(other.status, 0, other.err);
  const staged = commit(wt, { 'plugin/mechanisms/b.json': record('b', { file: 'pretool.d/20-b.cjs', handler: 'bb' }) });
  assert.strictEqual(staged.status, 0, `the unstaged module is not part of the commit: ${staged.err}`);
});

test('registry: record defects are named — unknown stage, event not matching its folder, id not matching the file name', () => {
  let checkRecords = null;
  try { ({ checkRecords } = require('./registry.cjs')); } catch { /* red: no registry yet */ }
  assert.strictEqual(typeof checkRecords, 'function', 'registry.cjs exports checkRecords');
  const res = checkRecords([
    { name: 'a.json', rec: JSON.parse(record('a', { stage: 'later' })) },
    { name: 'b.json', rec: JSON.parse(record('b', { file: 'stop.d/10-b.cjs' })) },
    { name: 'c.json', rec: JSON.parse(record('x')) },
  ], { modules: ['pretool.d/10-a.cjs', 'stop.d/10-b.cjs', 'pretool.d/10-x.cjs'], scenarios: ['H01'], today: '2026-11-05' });
  const text = res.errors.join('\n');
  assert.match(text, /a\.json.*stage/);
  assert.match(text, /b\.json.*Stop/);
  assert.match(text, /c\.json.*id/);
});
