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

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-memory-')); dirs.push(d); return d; };
function run(args, opts = {}) {
  const r = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, ...opts,
  });
  return { code: r.status, log: `${r.stdout || ''}${r.stderr || ''}` };
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
  assert.strictEqual(r.code, 0, r.log);
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
  assert.strictEqual(r.code, 0, r.log);
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
  assert.strictEqual(a.code, 0, a.log);
  assert.deepStrictEqual(tree(a.out), tree(b.out));
  const c = migrate(MAP, ['--check-twice']);
  assert.strictEqual(c.code, 0, c.log);
  assert.match(c.log, /два прогона: побайтно равны/);
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
    assert.strictEqual(r.code, 1, r.log);
    assert.match(r.log, re);
    assert.ok(!fs.existsSync(r.out), 'nothing written on a refusal');
  });
}

test('a refusal leaves an earlier --out as it was', () => {
  const r = migrate();
  assert.strictEqual(r.code, 0, r.log);
  const before = tree(r.out);
  const m = clone(MAP);
  demo(m).archive.pop();
  const mapFile = path.join(r.dir, 'bad.json');
  fs.writeFileSync(mapFile, JSON.stringify(m));
  const again = run(['--snapshot', SNAP, '--map', mapFile, '--out', r.out]);
  assert.strictEqual(again.code, 1, again.log);
  assert.deepStrictEqual(tree(r.out), before);
});

test('--out that is no earlier run, or holds the inputs, is refused and left as it was', () => {
  // a folder of other things: the map, notes — replacing it would delete them
  const d = tmp();
  fs.cpSync(path.join(HERE, 'example'), path.join(d, 'example'), { recursive: true });
  fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  const before = tree(d);
  const r = run(['--snapshot', path.join(d, 'example', 'snapshot'), '--map', path.join(d, 'example', 'map.json'), '--out', d]);
  assert.strictEqual(r.code, 1, r.log);
  assert.match(r.log, /--out/);
  assert.deepStrictEqual(tree(d), before);
  // inside the snapshot: the run would land in the memory it reads
  const inside = path.join(d, 'example', 'snapshot', 'projects', 'demo', 'memory', 'run');
  const r2 = run(['--snapshot', path.join(d, 'example', 'snapshot'), '--map', path.join(d, 'example', 'map.json'), '--out', inside]);
  assert.strictEqual(r2.code, 1, r2.log);
  assert.ok(!fs.existsSync(inside));
  // a non-empty folder without the run's marker
  const other = path.join(d, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'keep.md'), 'k');
  const r3 = run(['--snapshot', SNAP, '--map', path.join(HERE, 'example', 'map.json'), '--out', other]);
  assert.strictEqual(r3.code, 1, r3.log);
  assert.deepStrictEqual(fs.readdirSync(other), ['keep.md']);
});

test('an earlier run in --out is replaced', () => {
  const r = migrate();
  assert.strictEqual(r.code, 0, r.log);
  const again = run(['--snapshot', SNAP, '--map', path.join(r.dir, 'map.json'), '--out', r.out]);
  assert.strictEqual(again.code, 0, again.log);
});

test('records: code blocks, «#» lines without a space and text after a comment are kept', () => {
  const d = tmp();
  const mem = path.join(d, 'snap', 'projects', 'p', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'recipes.md'), [
    '# Рецепты', '', '## Стенд', '- Поднять базу:', '```bash', '# поднять базу', 'docker compose up -d db', '```',
    '#!/usr/bin/env bash', '<!-- c --> после комментария текст', ''].join('\n'));
  fs.writeFileSync(path.join(mem, 'decisions.md'), [
    '# Журнал', '', '## 2026-09-01: решение', '**Выбрали:** скрипт', '```', '# комментарий в коде', 'echo 1', '```',
    '**Почему:** так', ''].join('\n'));
  const r = run(['--snapshot', path.join(d, 'snap'), '--list']);
  assert.strictEqual(r.code, 0, r.log);
  const all = r.log.trim().split('\n').map((l) => JSON.parse(l)).map((x) => x.text).join('\n');
  for (const s of ['# поднять базу', 'docker compose up -d db', '#!/usr/bin/env bash', 'после комментария текст', '# комментарий в коде', '**Почему:** так']) {
    assert.ok(all.includes(s), `потеряно: ${s}`);
  }
  const rows = r.log.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(rows.filter((x) => x.file === 'decisions.md').length, 1, 'a code block does not cut the section');
});

test('records: a code block inside a comment is still a comment; a comment inside a code block is text', () => {
  const d = tmp();
  const mem = path.join(d, 'snap', 'projects', 'p', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'errors.md'), ['# T', '', '<!-- шаблон:', '```bash', '# пример', '```', '-->', '- пункт',
    '- код:', '```', '<!-- не комментарий -->', '```', ''].join('\n'));
  const r = run(['--snapshot', path.join(d, 'snap'), '--list']);
  assert.strictEqual(r.code, 0, r.log);
  const texts = r.log.trim().split('\n').map((l) => JSON.parse(l).text);
  assert.strictEqual(texts.length, 2, texts.join(' | '));
  assert.strictEqual(texts[0], 'пункт');
  assert.match(texts[1], /<!-- не комментарий -->/);
});

test('--list prints every record with its ref, line and text as JSON lines (the map author works from it)', () => {
  const r = run(['--snapshot', SNAP, '--list']);
  assert.strictEqual(r.code, 0, r.log);
  const rows = r.log.trim().split('\n').map((l) => JSON.parse(l));
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

// --verify-live (slice 26, acceptance memory test 4): the live memory of a project after the migration — every v1
// record has an address (map lesson/decision/archive, or a double-write line «урок <id>» of a lesson that exists),
// every map lesson/decision is in lessons/ or decisions/, every file there passes validateLesson. Reads only.
function live() {
  const r = migrate();
  assert.strictEqual(r.code, 0, r.log);
  const mem = path.join(r.dir, 'projects', 'demo', 'memory');
  fs.cpSync(path.join(SNAP, 'projects', 'demo', 'memory'), mem, { recursive: true });
  for (const sub of ['lessons', 'decisions']) fs.cpSync(path.join(r.out, MEM, sub), path.join(mem, sub), { recursive: true });
  const mapFile = path.join(r.dir, 'map.json');
  return { mem, mapFile, verify: () => run(['--verify-live', mem, '--map', mapFile]) };
}

test('--verify-live: migrated live memory — code 0, orphans 0, the live tree untouched', () => {
  const l = live();
  const before = tree(l.mem);
  const r = l.verify();
  assert.strictEqual(r.code, 0, r.log);
  assert.match(r.log, /сирот 0/);
  assert.deepStrictEqual(tree(l.mem), before);
});

test('--verify-live: a new v1 record with no address — an orphan, code 1', () => {
  const l = live();
  fs.appendFileSync(path.join(l.mem, 'errors.md'), '- Новая запись, которой нет в соответствии.\n');
  const r = l.verify();
  assert.strictEqual(r.code, 1, r.log);
  assert.match(r.log, /сирота: [^\n]*errors\.md#/);
});

test('--verify-live: a double-write line «урок <id>» is addressed only when that lesson exists', () => {
  const l = live();
  const id = demo(MAP).lessons[0].id;
  fs.appendFileSync(path.join(l.mem, 'errors.md'), `- Эпизод сессии. (2026-11-06, урок ${id})\n`);
  let r = l.verify();
  assert.strictEqual(r.code, 0, r.log);
  assert.match(r.log, /двойная запись 1/);
  fs.appendFileSync(path.join(l.mem, 'errors.md'), '- Эпизод про несуществующий урок. (2026-11-06, урок nope-lesson)\n');
  r = l.verify();
  assert.strictEqual(r.code, 1, r.log);
  assert.match(r.log, /сирота: [^\n]*errors\.md#/);
});

test('--verify-live: a map lesson missing from lessons/ — named, code 1', () => {
  const l = live();
  const id = demo(MAP).lessons[0].id;
  fs.rmSync(path.join(l.mem, 'lessons', `${id}.md`));
  const r = l.verify();
  assert.strictEqual(r.code, 1, r.log);
  assert.match(r.log, new RegExp(`не перенесён: lessons/${id}\\.md`));
});

test('--verify-live: a lesson file the validator refuses — named, code 1; a valid new lesson is fine', () => {
  const l = live();
  const id = demo(MAP).lessons[0].id;
  fs.copyFileSync(path.join(l.mem, 'lessons', `${id}.md`), path.join(l.mem, 'lessons', 'fresh-one.md'));
  const fresh = path.join(l.mem, 'lessons', 'fresh-one.md');
  fs.writeFileSync(fresh, fs.readFileSync(fresh, 'utf8').replace(`id: ${id}`, 'id: fresh-one'));
  let r = l.verify();
  assert.strictEqual(r.code, 0, r.log);
  fs.appendFileSync(path.join(l.mem, 'lessons', `${id}.md`), 'хвост\u0000\n');
  r = l.verify();
  assert.strictEqual(r.code, 1, r.log);
  assert.match(r.log, new RegExp(`${id}\\.md`));
});

test('--verify-live: a project the map does not know — code 1; no --map — code 2', () => {
  const l = live();
  const other = path.join(path.dirname(path.dirname(l.mem)), 'stranger', 'memory');
  fs.cpSync(l.mem, other, { recursive: true });
  assert.strictEqual(run(['--verify-live', other, '--map', l.mapFile]).code, 1);
  assert.strictEqual(run(['--verify-live', l.mem]).code, 2);
});

test('--verify-live: lines of the real writer — episode.cjs add and repeat («, повтор» in Cyrillic) — are double writes', () => {
  const l = live();
  const E = path.join(HERE, '..', '..', 'plugin', 'skills', 'wind-down', 'scripts', 'episode.cjs');
  const id = demo(MAP).lessons[0].id;
  const r1 = spawnSync(process.execPath, [E, '--memory', l.mem, 'repeat', id, '--note', 'снова то же'], { encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r1.status, 0, `${r1.stdout}${r1.stderr}`);
  assert.match(fs.readFileSync(path.join(l.mem, 'errors.md'), 'utf8'), new RegExp(`урок ${id}, повтор\\)\\n$`));
  const r = l.verify();
  assert.strictEqual(r.code, 0, r.log);
  assert.match(r.log, /двойная запись 1/);
});

test('--verify-live: a --map that is missing or not JSON — a usage error, code 2, no traceback', () => {
  const l = live();
  const bad = path.join(path.dirname(l.mapFile), 'bad.json');
  fs.writeFileSync(bad, '{ не json');
  for (const m of [path.join(path.dirname(l.mapFile), 'nope.json'), bad]) {
    const r = run(['--verify-live', l.mem, '--map', m]);
    assert.strictEqual(r.code, 2, r.log);
    assert.doesNotMatch(r.log, /Traceback/);
  }
});

test('--verify-live: a --map of valid JSON but the wrong shape — a usage error, code 2, no traceback', () => {
  const l = live();
  const bad = path.join(path.dirname(l.mapFile), 'shape.json');
  for (const body of ['{"projects":[1]}', '[]', '{"version":1,"projects":{"demo":[1]}}']) {
    fs.writeFileSync(bad, body);
    const r = run(['--verify-live', l.mem, '--map', bad]);
    assert.strictEqual(r.code, 2, `${body}: ${r.log}`);
    assert.doesNotMatch(r.log, /Traceback/);
  }
});
