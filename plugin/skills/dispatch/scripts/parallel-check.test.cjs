// node --test parallel-check.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'parallel-check.sh');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// Regression: under a ru_RU locale uutils sort collates (case and punctuation folded) while comm compares bytes,
// and ~9% of the common files went missing. The script must fix the collation itself, whatever the caller's locale.
test('parallel-check: every common file is listed under a non-C locale (mixed case, punctuation, Cyrillic)', (t) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t'); git(r, 'config', 'user.name', 't');
  const stems = ['a', 'A', 'b', 'B', '_a', 'a-b', 'a_b', 'a.b', 'Z', 'z', '0', '9', 'ab', 'aB', 'Ab', 'ё', 'Ю', 'я', 'a b'];
  const all = stems.flatMap((s) => [`src/${s}.ts`, `src/${s}/x.ts`, `${s}.md`]);
  for (const f of all) write(path.join(r, f), 'base\n');
  git(r, 'add', '--', ...all); git(r, 'commit', '-q', '-m', 'base');
  // Every second file is common: both branches make the same change, so merge-tree stays clean.
  const common = all.filter((_, i) => i % 2 === 0);
  const branch = (name, extra) => {
    git(r, 'switch', '-q', '-c', name, 'main');
    for (const f of common) write(path.join(r, f), 'same\n');
    for (const f of extra) write(path.join(r, f), `${name}\n`);
    git(r, 'commit', '-q', '-am', name);
  };
  branch('b1', all.filter((_, i) => i % 4 === 1));
  branch('b2', all.filter((_, i) => i % 4 === 3));
  // LC_ALL is dropped, not emptied: uutils reads an empty LC_ALL as C and the bug hides.
  const env = { ...process.env, LANG: 'ru_RU.UTF-8', LC_COLLATE: 'ru_RU.UTF-8', HOT: '^never$' };
  delete env.LC_ALL;
  const res = spawnSync('bash', [SCRIPT, r, 'main', 'b1', 'b2'], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 3, res.stdout + res.stderr);
  assert.match(res.stdout, /^общие файлы b1 × b2/m);
  const listed = res.stdout.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.slice(2));
  assert.deepStrictEqual(listed.sort(), [...common].sort());
});
