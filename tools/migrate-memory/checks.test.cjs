// The checks on a migrated copy: why.cjs («почему так решили» through the memory search) and triggers.cjs (the
// lessons' `when` against real calls — noise — and against the replay cases — hits), on the synthetic example.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HERE = __dirname;
const EX = path.join(HERE, 'example');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-checks-')); dirs.push(d); return d; };

// The example migrated once for the whole file.
const RUN = (() => {
  const d = tmp();
  const r = spawnSync('python3', [path.join(HERE, 'migrate.py'), '--snapshot', path.join(EX, 'snapshot'),
    '--map', path.join(EX, 'map.json'), '--out', path.join(d, 'run')],
  { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (r.status !== 0) throw new Error(`migrate.py: ${r.stdout}${r.stderr}`);
  return path.join(d, 'run');
})();
const tree = (dir) => spawnSync('find', [dir, '-type', 'f'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
const node = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, log: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};

test('why.cjs: each question → the memory search on a copy; hit when an expected decision is in the top 3', () => {
  const before = tree(RUN);
  const r = node('why.cjs', ['--out', RUN, '--set', path.join(EX, 'why.json'), '--min', '1']);
  assert.match(r.log, /✓ demo: почему два отчёта .*→ two-reports-by-source/);
  assert.match(r.log, /✓ demo: как входим в дев-окружение/);
  assert.match(r.log, /почему так решили: 2\/3 \(67 %\), порог 80 % — не прошло/);
  assert.strictEqual(r.code, 1, r.log);
  assert.deepStrictEqual(tree(RUN), before, 'the run itself gets no index files: the search works on a copy');
});

test('why.cjs: an expected id that is no decision of the run, or a set outside 15–20, is refused', () => {
  const d = tmp();
  const set = JSON.parse(fs.readFileSync(path.join(EX, 'why.json'), 'utf8'));
  set.questions[0].expect = 'no-such-decision';
  fs.writeFileSync(path.join(d, 'bad.json'), JSON.stringify(set));
  const bad = node('why.cjs', ['--out', RUN, '--set', path.join(d, 'bad.json'), '--min', '1']);
  assert.strictEqual(bad.code, 1, bad.log);
  assert.match(bad.log, /нет решения demo\/no-such-decision/);
  const few = node('why.cjs', ['--out', RUN, '--set', path.join(EX, 'why.json')]);
  assert.strictEqual(few.code, 1, few.log);
  assert.match(few.log, /вопросов 3, а нужно 15–20/);
  assert.strictEqual(node('why.cjs', ['--out', RUN]).code, 2);
});

function callsDb() {
  const file = path.join(tmp(), 'calls.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE calls(id primary key, session, agent, epoch, pdir, tool, cmd, path)');
  const ins = db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let id = 0;
  const add = (session, pdir, tool, cmd, p = null) => ins.run(++id, session, '', 0, pdir, tool, cmd, p);
  const demo = '-home-u-hub-projects-demo';
  add('s1', demo, 'Bash', "python3 - <<'EOF'\nprint(1)\nEOF");
  add('s1', demo, 'Bash', 'npm test');
  add('s1', demo, 'Bash', 'npm run lint'); // the same lesson again in the same epoch: not delivered twice
  add('s1', `${demo}-worktrees-T1`, 'Bash', 'cd /x && ls'); // a worktree of the project is the project
  for (let i = 0; i < 16; i++) add('s1', demo, i % 2 ? 'Read' : 'Bash', i % 2 ? null : 'ls', i % 2 ? '/a/b.ts' : null);
  add('s2', demo, 'Bash', 'npm i');
  for (let i = 0; i < 9; i++) add('s2', demo, 'Bash', 'ls');
  add('s3', '-home-u-hub-projects-other', 'Bash', "cat <<'EOF'"); // another project: not counted
  db.close();
  return file;
}

test('triggers.cjs: deliveries once per (session, agent, epoch, lesson), per 20 calls, median per session, cases', () => {
  const out = path.join(tmp(), 'report.json');
  const r = node('triggers.cjs', ['--out', RUN, '--calls', callsDb(), '--cases', path.join(EX, 'cases.json'),
    '--noisy-rate', '0.05', '--json', out]);
  assert.strictEqual(r.code, 0, r.log);
  const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
  const p = rep.projects.demo;
  assert.strictEqual(p.lessons_with_when, 3);
  assert.strictEqual(p.calls, 30);
  assert.strictEqual(p.deliveries, 4);
  assert.strictEqual(p.per20, 2.67);
  assert.strictEqual(p.sessions, 2);
  assert.strictEqual(p.median_lessons_per_session, 2);
  assert.deepStrictEqual(p.noisy.map((n) => [n.id, n.calls]), [['tests-not-from-repo-root', 3]]);
  assert.strictEqual(rep.cases.hits, 1);
  assert.strictEqual(rep.cases.total, 3);
  const why = Object.fromEntries(rep.cases.list.map((c) => [c.id, c.result]));
  assert.deepStrictEqual(why, { 'heredoc-hit': 'попал: bash-inline-script-to-file', 'cd-before-lesson': 'урока ещё не было: cd-in-subshell',
    'no-trigger': 'нет урока с when под вызов и текстом gold' });
  assert.match(r.log, /demo: вызовов 30, подач 4 \(2\.67 на 20\), медиана уроков на сессию 2/);
  assert.match(r.log, /replay: 1\/3/);
});
