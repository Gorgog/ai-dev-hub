// migrate.py on the synthetic snapshot: v1 memory → v2 lessons and decisions by the map, deterministic, every record
// addressed, nothing written on a refusal; every written file passes the memory library's validator (slice 14).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateLesson, parseLesson } = require('../../plugin/lib/memory/format.cjs');

const HERE = __dirname;
const SCRIPT = path.join(HERE, 'migrate.py');
const SNAP = path.join(HERE, 'example', 'snapshot');
const MAP = JSON.parse(fs.readFileSync(path.join(HERE, 'example', 'map.json'), 'utf8'));
const MEM = 'projects/demo/memory';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-memory-'));
function run(args, opts = {}) {
  const r = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, ...opts,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function migrate(map = MAP, extra = [], snap = SNAP) {
  const dir = tmp();
  const mapFile = path.join(dir, 'map.json');
  fs.writeFileSync(mapFile, JSON.stringify(map, null, 1));
  const out = path.join(dir, 'out');
  return { ...run(['--snapshot', snap, '--map', mapFile, '--out', out, ...extra]), out, dir };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const demo = (m) => m.projects.demo;
function tree(dir) {
  const files = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files[path.relative(dir, p)] = fs.readFileSync(p);
    }
  })(dir);
  return files;
}

test('example map: lessons and decisions written, each passes validateLesson, source «модель (миграция)»', () => {
  const r = migrate();
  assert.strictEqual(r.code, 0, r.out);
  const lessons = fs.readdirSync(path.join(r.out, MEM, 'lessons')).sort();
  const decisions = fs.readdirSync(path.join(r.out, MEM, 'decisions')).sort();
  assert.deepStrictEqual(lessons, demo(MAP).lessons.map((l) => `${l.id}.md`).sort());
  assert.deepStrictEqual(decisions, demo(MAP).decisions.map((l) => `${l.id}.md`).sort());
  for (const [sub, names] of [['lessons', lessons], ['decisions', decisions]]) {
    for (const n of names) {
      const file = path.join(r.out, MEM, sub, n);
      const buf = fs.readFileSync(file);
      assert.deepStrictEqual(validateLesson(buf, { file }), [], `${sub}/${n}`);
      const { meta } = parseLesson(buf.toString('utf8'));
      assert.strictEqual(meta.source, 'модель (миграция)');
      if (sub === 'decisions') assert.strictEqual(meta.kind, 'decision');
    }
  }
  const once = parseLesson(fs.readFileSync(path.join(r.out, MEM, 'lessons', 'test-on-clean-branch-first.md'), 'utf8')).meta;
  assert.strictEqual(once.kind, 'once');
  assert.strictEqual(once.status, 'active', 'класс «одного раза» — живой урок, не отставка');
  const core = parseLesson(fs.readFileSync(path.join(r.out, MEM, 'lessons', 'bash-inline-script-to-file.md'), 'utf8')).meta;
  assert.strictEqual(core.status, 'core');
  assert.deepStrictEqual(core.when, [{ tool: '^Bash$', cmd: "<<\\s*'?EOF|node\\s+-e" }]);
});

test('anchor: every record of every source file is addressed, orphans 0, counts add up', () => {
  const r = migrate();
  assert.strictEqual(r.code, 0, r.out);
  const anchor = JSON.parse(fs.readFileSync(path.join(r.out, 'anchor.json'), 'utf8'));
  const addr = JSON.parse(fs.readFileSync(path.join(r.out, 'addresses.json'), 'utf8'));
  assert.strictEqual(anchor.records, 12, JSON.stringify(anchor));
  assert.strictEqual(anchor.orphans, 0);
  assert.strictEqual(anchor.addressed, 12);
  assert.deepStrictEqual(Object.keys(anchor.sources).sort(),
    ['demo/decisions.md', 'demo/errors-index.md', 'demo/errors.md', 'demo/recipes.md']);
  assert.match(anchor.sources['demo/errors.md'].sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(Object.keys(addr).length, 12);
  // the split record went to two lessons, each part named; the duplicate text has its own ref
  const split = addr['demo/errors.md#4228d715ff97'];
  assert.deepStrictEqual(split.map((a) => [a.to, a.id, a.part]).sort(),
    [['lesson', 'cd-in-subshell', 'cd'], ['lesson', 'test-on-clean-branch-first', 'чистая ветка']]);
  assert.strictEqual(addr['demo/errors.md#5d0308152927.2'][0].id, 'tests-not-from-repo-root');
  assert.strictEqual(addr['demo/errors.md#17c466b34270'][0].to, 'archive');
  assert.match(addr['demo/errors.md#17c466b34270'][0].reason, /Windows/);
  assert.strictEqual(addr['demo/decisions.md#d532e6d17628'][0].to, 'decision');
  assert.strictEqual(addr['demo/errors.md#ae61a704a9b7'][0].line, 13, 'a paragraph outside bullets is a record too');
});

test('two runs on one snapshot are byte-identical; --check-twice says so and leaves one tree', () => {
  const a = migrate();
  const b = migrate();
  assert.strictEqual(a.code, 0, a.out);
  assert.deepStrictEqual(tree(a.out), tree(b.out));
  const c = migrate(MAP, ['--check-twice']);
  assert.strictEqual(c.code, 0, c.out);
  assert.match(c.out, /два прогона: побайтно равны/);
  assert.deepStrictEqual(tree(c.out), tree(a.out));
  assert.deepStrictEqual(fs.readdirSync(c.dir).sort(), ['map.json', 'out'], 'no temporary run left next to --out');
});

const refusals = [
  ['an orphan: a record nobody claims', (m) => { demo(m).archive.pop(); }, /сирота: demo\/recipes\.md#366b3e561a43 \(строка 3\)/],
  ['a project of the snapshot missing from the map', (m) => { m.projects = {}; }, /сирота: demo\/decisions\.md#d532e6d17628/],
  ['an unknown ref', (m) => { demo(m).archive.push({ ref: 'errors.md#000000000000', reason: 'x' }); }, /нет в снимке: demo\/errors\.md#000000000000/],
  ['a ref claimed twice', (m) => { demo(m).archive.push({ ref: 'errors.md#541f6b7e6e7f', reason: 'x' }); }, /дважды: demo\/errors\.md#541f6b7e6e7f/],
  ['a lone part', (m) => { demo(m).lessons[2].from = ['recipes.md#e6200c52fe06']; demo(m).lessons.splice(5, 1); }, /одна часть: demo\/errors\.md#4228d715ff97/],
  ['archive without a reason', (m) => { demo(m).archive[0].reason = ''; }, /архив без причины: demo\/errors\.md#17c466b34270/],
  ['an id twice (lesson and decision)', (m) => { demo(m).decisions[0].id = 'cd-in-subshell'; }, /id дважды: demo\/cd-in-subshell/],
  ['a lesson from nothing', (m) => { demo(m).lessons.push({ ...demo(m).lessons[4], id: 'empty', from: [] }); }, /empty: урок ни из чего/],
  ['a when string instead of fields', (m) => { demo(m).lessons[1].when = ['[PreToolUse:Bash]']; }, /cd-in-subshell\.md: when\[0\]: нужен блок полей/],
  ['a first line over 160', (m) => { demo(m).lessons[1].text[0] = 'я'.repeat(161); }, /cd-in-subshell\.md: первая строка — 161 знаков/],
  ['a URL in the text', (m) => { demo(m).lessons[1].text[1] = 'см. https://example.org'; }, /cd-in-subshell\.md: URL в тексте/],
  ['a key that would not survive the file (comma)', (m) => { demo(m).lessons[1].keys = ['a, b']; }, /cd-in-subshell: keys .*не переживает запись/],
  ['a kind outside the lesson set', (m) => { demo(m).lessons[1].kind = 'decision'; }, /cd-in-subshell: kind «decision»/],
  ['a status the migration does not write', (m) => { demo(m).lessons[1].status = 'retired'; }, /cd-in-subshell: status «retired»/],
  ['a missing field', (m) => { delete demo(m).lessons[1].created; }, /cd-in-subshell: нет полей created/],
];
for (const [name, mutate, re] of refusals) {
  test(`refused, nothing written: ${name}`, () => {
    const m = clone(MAP);
    mutate(m);
    const r = migrate(m);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, re);
    assert.ok(!fs.existsSync(r.out), 'nothing written on a refusal');
  });
}

test('a refusal leaves an earlier --out as it was', () => {
  const r = migrate();
  assert.strictEqual(r.code, 0, r.out);
  const before = tree(r.out);
  const m = clone(MAP);
  demo(m).archive.pop();
  const mapFile = path.join(r.dir, 'bad.json');
  fs.writeFileSync(mapFile, JSON.stringify(m));
  const again = run(['--snapshot', SNAP, '--map', mapFile, '--out', r.out]);
  assert.strictEqual(again.code, 1, again.out);
  assert.deepStrictEqual(tree(r.out), before);
});

test('--list prints every record with its ref, line and text as JSON lines (the map author works from it)', () => {
  const r = run(['--snapshot', SNAP, '--list']);
  assert.strictEqual(r.code, 0, r.out);
  const rows = r.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 12);
  const sec = rows.find((x) => x.ref === 'decisions.md#d532e6d17628');
  assert.strictEqual(sec.project, 'demo');
  assert.strictEqual(sec.unit, 'section');
  assert.match(sec.text, /### Дополнение\nПозже подтвердили на демо\.$/, 'a section keeps its ### and lines');
  assert.ok(!rows.some((x) => /строка внутри комментария/.test(x.text)), 'comments are not records');
});

test('usage: no --map / --out → code 2', () => {
  assert.strictEqual(run(['--snapshot', SNAP]).code, 2);
});
