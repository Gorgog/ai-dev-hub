// node --test mutants.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runMutants } = require('./mutants.cjs');

function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-'));
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'calc.js'), 'exports.add = (a, b) => a + b;\nexports.limit = 10;\n');
  fs.writeFileSync(path.join(r, 'other.js'), 'exports.x = 1;\n');
  // The "test suite": checks add only, never limit — so a limit mutant survives.
  fs.writeFileSync(path.join(r, 'check.js'), "const c = require('./calc.js'); process.exit(c.add(2, 2) === 4 ? 0 : 1);\n");
  git('add', '.'); git('commit', '-q', '-m', 'x');
  return r;
}

test('mutants: killed, survived, find not unique, dirty file skipped; every file restored', () => {
  const r = repo();
  fs.writeFileSync(path.join(r, 'other.js'), 'exports.x = 2;\n'); // uncommitted edit
  const before = fs.readFileSync(path.join(r, 'calc.js'), 'utf8');
  const res = runMutants({
    cwd: r, cmd: 'node check.js', mutants: [
      { id: 'add-minus', file: 'calc.js', find: 'a + b', replace: 'a - b' },
      { id: 'limit-11', file: 'calc.js', find: 'limit = 10', replace: 'limit = 11' },
      { id: 'missing', file: 'calc.js', find: 'nothing here', replace: 'x' },
      { id: 'dirty', file: 'other.js', find: 'x = 2', replace: 'x = 3' },
    ],
  }, { scratch: fs.mkdtempSync(path.join(os.tmpdir(), 'mu-s-')) });
  assert.deepStrictEqual(res.results.map((x) => [x.id, x.status]),
    [['add-minus', 'KILLED'], ['limit-11', 'SURVIVED'], ['missing', 'ERROR'], ['dirty', 'SKIP']]);
  assert.strictEqual(fs.readFileSync(path.join(r, 'calc.js'), 'utf8'), before);
  assert.strictEqual(fs.readFileSync(path.join(r, 'other.js'), 'utf8'), 'exports.x = 2;\n');
  assert.deepStrictEqual(res.notRestored, []);
  assert.match(res.text, /убито 1 · выжило 1 · пропущено 2/);
  assert.match(res.text, /выжил: limit-11/);
});

test('mutants: a run killed mid-mutant leaves a backup; the next run restores the file before anything else', () => {
  const r = repo();
  const original = fs.readFileSync(path.join(r, 'calc.js'), 'utf8');
  const { pendingFile } = require('./mutants.cjs');
  // What a killed run leaves: the mutated file and its pending backup.
  const pend = pendingFile(r);
  fs.mkdirSync(path.dirname(pend), { recursive: true });
  const mutated = original.replace('a + b', 'a - b');
  fs.writeFileSync(pend, JSON.stringify([{ file: path.join(r, 'calc.js'), original, mutated }]));
  fs.writeFileSync(path.join(r, 'calc.js'), mutated);
  const res = runMutants({ cwd: r, cmd: 'node check.js', mutants: [] }, { scratch: fs.mkdtempSync(path.join(os.tmpdir(), 'mu-s-')) });
  assert.strictEqual(fs.readFileSync(path.join(r, 'calc.js'), 'utf8'), original);
  assert.match(res.text, /восстановлен после обрыва: .*calc\.js/);
  assert.ok(!fs.existsSync(pend));
});

test('mutants: after a kill the file was fixed and edited by hand — the backup never overwrites that work', () => {
  const r = repo();
  const original = fs.readFileSync(path.join(r, 'calc.js'), 'utf8');
  const { pendingFile } = require('./mutants.cjs');
  const pend = pendingFile(r);
  fs.writeFileSync(pend, JSON.stringify([{ file: path.join(r, 'calc.js'), original, mutated: original.replace('a + b', 'a - b') }]));
  const work = original + 'exports.mul = (a, b) => a * b;\n';
  fs.writeFileSync(path.join(r, 'calc.js'), work); // restored by hand and new uncommitted work
  const res = runMutants({ cwd: r, cmd: 'node check.js', mutants: [] }, { scratch: fs.mkdtempSync(path.join(os.tmpdir(), 'mu-s-')) });
  assert.strictEqual(fs.readFileSync(path.join(r, 'calc.js'), 'utf8'), work);
  assert.match(res.text, /не тронут: .*calc\.js/);
  assert.ok(!fs.existsSync(pend));
});

test('mutants: the backup is on disk while the mutant runs', () => {
  const r = repo();
  // The "suite" fails exactly when a pending backup exists — so KILLED proves the backup was written first.
  fs.writeFileSync(path.join(r, 'probe.js'), "process.exit(require('fs').existsSync(process.argv[2]) ? 1 : 0);\n");
  const { pendingFile } = require('./mutants.cjs');
  const res = runMutants({ cwd: r, cmd: `node probe.js "${pendingFile(r)}"`, mutants: [{ id: 'm', file: 'calc.js', find: 'a + b', replace: 'a - b' }] },
    { scratch: fs.mkdtempSync(path.join(os.tmpdir(), 'mu-s-')) });
  assert.deepStrictEqual(res.results.map((x) => x.status), ['KILLED']);
});

test('mutants: «$» in replace is literal, not a replacement pattern', () => {
  const r = repo();
  // Fails (KILLED) only if the literal text $&$$ reached the file; a pattern replace would put «limit = 10$» there.
  fs.writeFileSync(path.join(r, 'lit.js'), "process.exit(require('fs').readFileSync('calc.js', 'utf8').includes(\"'$&$$'\") ? 1 : 0);\n");
  const res = runMutants({ cwd: r, cmd: 'node lit.js', mutants: [{ id: 'dollar', file: 'calc.js', find: 'limit = 10', replace: "limit = '$&$$'" }] },
    { scratch: fs.mkdtempSync(path.join(os.tmpdir(), 'mu-s-')) });
  assert.deepStrictEqual(res.results.map((x) => x.status), ['KILLED']);
});

test('mutants CLI: red baseline or a mutant that could not run — exit 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-c-'));
  const r = repo();
  const run = (cfg) => {
    fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify(cfg));
    try { execFileSync('node', [path.join(__dirname, 'mutants.cjs'), path.join(dir, 'm.json')], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; }
  };
  assert.strictEqual(run({ cwd: r, cmd: 'node -e "process.exit(1)"', mutants: [{ id: 'a', file: 'calc.js', find: 'a + b', replace: 'a - b' }] }), 2);
  assert.strictEqual(run({ cwd: r, cmd: 'node check.js', mutants: [{ id: 'a', file: 'calc.js', find: 'nope', replace: 'x' }] }), 2);
  assert.strictEqual(run({ cwd: r, cmd: 'node check.js', mutants: [{ id: 'a', file: 'calc.js', find: 'a + b', replace: 'a - b' }] }), 0);
});

test('mutants CLI: a broken config is exit 2, not the «survived» code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-c-'));
  fs.writeFileSync(path.join(dir, 'm.json'), '{ broken');
  let code = 0;
  try { execFileSync('node', [path.join(__dirname, 'mutants.cjs'), path.join(dir, 'm.json')], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
});

test('mutants: tests red without any mutant — nothing is counted as killed', () => {
  const r = repo();
  const res = runMutants({ cwd: r, cmd: 'node -e "process.exit(1)"', mutants: [{ id: 'add-minus', file: 'calc.js', find: 'a + b', replace: 'a - b' }] },
    { scratch: fs.mkdtempSync(path.join(os.tmpdir(), 'mu-s-')) });
  assert.deepStrictEqual(res.results.map((x) => x.status), ['ERROR']);
  assert.match(res.text, /без мутантов тесты красные/);
});
