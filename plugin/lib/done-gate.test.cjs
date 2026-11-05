// node --test done-gate.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { isReport, target, basics, facts, lastFullPath } = require('./done-gate.cjs');

const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// hub/projects/demo/repo on main + worktrees/<name> helpers.
function project() {
  const hub = mkdtemp('dg-');
  const dir = path.join(hub, 'projects', 'demo');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'x');
  const commit = (cwd, file, msg = file) => { fs.writeFileSync(path.join(cwd, file), file); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
  const wt = (name) => { const d = path.join(dir, 'worktrees', name); git(repo, 'worktree', 'add', '-q', '-b', name, d); return d; };
  return { hub, proj: { dir, name: 'demo' }, repo, git, commit, wt };
}
const writeFull = (wt, data) => { const f = lastFullPath(wt); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data)); };

test('isReport: a line that starts with the phrase is a report; a mention, a quote, a status or a negation is not', () => {
  for (const t of ['Готово к пушу: K-1 abc1234', '**Готово к пушу** — K-1', 'Сделал.\n\nГотово к пушу (K-1, abc1234)', '## Готово к пушу: K-1',
    '- готово к пушу: K-1']) assert.strictEqual(isReport(t), 'push', t);
  assert.strictEqual(isReport('готово к мержу: HUBV2-3 abc1234'), 'merge');
  for (const t of ['Ещё не готово к пушу: жду ревью', 'Дальше: допишу тест и пришлю «готово к пушу» с sha.',
    'Сессия K-2 прислала «готово к пушу» (a1b2c3d).', 'Статус: ревью · abc1234 | Ждёт: — | Дальше: доклад «готово к пушу»',
    '> Готово к пушу: K-2 a1b2c3d', 'Время — до состояния\n«готово к пушу»: тесты, ревью.', '', null]) {
    assert.strictEqual(isReport(t), null, String(t));
  }
});

test('target: the copy of the cwd, a named worktree from the project folder; the project folder alone — none', () => {
  const p = project();
  const w3 = p.wt('K-3'), w7 = p.wt('K-7');
  assert.strictEqual(target(w3, 'Готово к пушу: работа в worktrees/K-7, HEAD abc', p.proj), w3, 'no HEAD named — the own copy (review 1)');
  assert.strictEqual(target(p.proj.dir, 'Готово к пушу: работа в worktrees/K-7', p.proj), w7);
  assert.strictEqual(target(path.join(w3, 'sub'), 'Готово к пушу: K-3', p.proj), w3);
  assert.strictEqual(target(w3, 'Готово к пушу: worktrees/K-404 abc', p.proj), w3);
  assert.strictEqual(target(p.repo, 'Готово к пушу', p.proj), p.repo);
  assert.strictEqual(target(p.proj.dir, 'Готово к пушу: K-3', p.proj), null);
});

test('basics: clean tree and a sha of HEAD in the text; an invented sha is not HEAD', () => {
  const p = project();
  const head = p.git(p.repo, 'rev-parse', 'HEAD');
  assert.deepStrictEqual(basics(`Готово к пушу: K-1, HEAD ${head.slice(0, 7)}`, p.repo), []);
  assert.deepStrictEqual(basics(`Готово к пушу: K-1, HEAD ${head.slice(0, 10)}`, p.repo), []);
  assert.match(basics('Готово к пушу: K-1, HEAD 7c4c9f0d5', p.repo).join(), /нет HEAD/);
  fs.writeFileSync(path.join(p.repo, 'wip.txt'), 'x');
  assert.match(basics(`Готово к пушу ${head.slice(0, 7)}`, p.repo).join(), /не чистое: wip\.txt/);
  fs.writeFileSync(path.join(p.repo, 'a.txt'), 'changed');
  assert.match(basics(`Готово к пушу ${head.slice(0, 7)}`, p.repo).join(), /не чистое: a\.txt, wip\.txt/, 'a modified file first: its « M » prefix');
});

test('facts: without checks.json — only behind the base; with it — checks --full green on the final HEAD of a clean tree', () => {
  const p = project();
  const w = p.wt('K-1');
  const head = p.commit(w, 'b.txt');
  assert.deepStrictEqual(facts(w, p.proj, 'push'), [], 'no checks.json, up to date');
  fs.writeFileSync(path.join(p.proj.dir, 'checks.json'), JSON.stringify({ base: 'main', full: [] }));
  assert.match(facts(w, p.proj, 'push').join(), /checks.*--full.*не прогнан/);
  writeFull(w, { sha: head, code: 0, clean: true });
  assert.deepStrictEqual(facts(w, p.proj, 'push'), []);
  writeFull(w, { sha: head, code: 1, clean: true, steps: [{ name: 'tsc', status: 'FAIL' }] });
  assert.match(facts(w, p.proj, 'push').join(), /красный.*tsc/);
  writeFull(w, { sha: head, code: 0, clean: false });
  assert.match(facts(w, p.proj, 'push').join(), /грязном дереве/);
  // The fact of slice 11: the full run, then a docs commit — the run is not of the final HEAD.
  writeFull(w, { sha: head, code: 0, clean: true });
  p.commit(w, 'NOTES.md', 'docs: заметка');
  const after = facts(w, p.proj, 'push').join();
  assert.match(after, new RegExp(`${head.slice(0, 7)}`));
  assert.match(after, /docs: заметка/);
  fs.writeFileSync(lastFullPath(w), '{broken');
  assert.match(facts(w, p.proj, 'push').join(), /не прогнан/);
});

test('facts: a branch behind its base blocks a push report, not a merge report; the base — checks.json, else the main copy branch', () => {
  const p = project();
  const behind = p.wt('K-9');
  p.commit(behind, 'k9.txt');
  p.commit(p.repo, 'c.txt', 'main moved');
  const fresh = p.wt('K-8');
  p.commit(fresh, 'k8.txt');
  assert.match(facts(behind, p.proj, 'push').join(), /отстала от main на 1/);
  assert.deepStrictEqual(facts(behind, p.proj, 'merge'), []);
  assert.deepStrictEqual(facts(fresh, p.proj, 'push'), []);
  assert.deepStrictEqual(facts(p.repo, p.proj, 'push'), [], 'the main copy is not behind itself');
  fs.writeFileSync(path.join(p.proj.dir, 'checks.json'), JSON.stringify({ base: 'origin/nope', full: [] }));
  writeFull(behind, { sha: p.git(behind, 'rev-parse', 'HEAD'), code: 0, clean: true });
  assert.deepStrictEqual(facts(behind, p.proj, 'push'), [], 'an unreadable base is no proof of being behind');
});

test('review 1: isReport — no punctuation after the phrase, a numbered list, an emoji', () => {
  for (const t of ['Готово к пушу HEAD abc1234, дерево чистое', '1. Готово к пушу: abc1234', 'Готово к пушу ✅ abc1234', 'ГОТОВО К ПУШУ: x'])
    assert.strictEqual(isReport(t), 'push', t);
  assert.strictEqual(isReport('готово к пушуху'), null);
});

test('review 1: target — the own copy whose HEAD the report names wins over a worktree it only mentions', () => {
  const p = project();
  const w16 = p.wt('K-16'), w17 = p.wt('K-17');
  p.commit(w17, 'x.txt');
  const h16 = p.git(w16, 'rev-parse', '--short', 'HEAD');
  const h17 = p.git(w17, 'rev-parse', '--short', 'HEAD');
  assert.strictEqual(target(w16, `Готово к пушу: K-16 ${h16}. Пересекается с worktrees/K-17 (не трогал).`, p.proj), w16);
  assert.strictEqual(target(w16, `Готово к пушу: работа в worktrees/K-17, HEAD ${h17}`, p.proj), w17);
  assert.strictEqual(target(w16, 'Готово к пушу: K-16 1234567. Пересекается с worktrees/K-17.', p.proj), w16, 'no sha matches — the own copy');
  assert.strictEqual(target(p.proj.dir, `Готово к пушу: worktrees/K-17 ${h17}`, p.proj), w17, 'from the project folder — the named one');
});

test('review 1: base without checks.json — the trunk (main/master), not the branch of the main copy, not a neighbour', () => {
  const p = project();
  const feat = p.wt('feat');
  p.commit(feat, 'f.txt');
  p.git(p.repo, 'switch', '-q', '-c', 'TASK-1');
  p.commit(p.repo, 't.txt', 'task commit in the main copy');
  assert.deepStrictEqual(facts(feat, p.proj, 'push'), [], 'the main copy on a task branch is not the base');
  p.git(p.repo, 'switch', '-q', '--detach');
  const other = p.wt('other');
  p.commit(feat, 'g.txt');
  assert.deepStrictEqual(facts(other, p.proj, 'push'), [], 'detached main copy: not the neighbour\'s branch');
  p.git(p.repo, 'switch', '-q', 'main');
  p.commit(p.repo, 'm.txt', 'main moved');
  assert.match(facts(other, p.proj, 'push').join(), /отстала от main на 1/);
});

test('review 2: a report with a question later on its line is a report; the phrase going on in Russian words — too', () => {
  for (const t of ['Готово к пушу: 2c049b8. Пушить?', 'Готово к пушу (2c049b8) — пушим?', 'Готово к пушу HEAD 2c049b8 — пушить?', '✅ Готово к пушу: abc1234'])
    assert.strictEqual(isReport(t), 'push', t);
  // No «status» exception either (decision 05.11): «Готово к пушу после всех проверок» would pass the gate like «Пушить?».
  for (const t of ['Готово к пушу после ревью второго круга.', 'Готово к мержу будет после правок.', 'Готово к пушу после всех проверок'])
    assert.ok(isReport(t), t);
});

test('review 3: every line that starts with the phrase is judged, a question included', () => {
  for (const t of ['Готово к пушу. Пушить?', 'Готово к пушу: проверено — пушить?', 'Готово к пушу — ветка K-16, пушить?', 'Готово к пушу: ждёт ответа — пушить?'])
    assert.strictEqual(isReport(t), 'push', t);
  // No «question» exception (decision 05.11): a real question gets a cheap false block, the second Stop passes.
  for (const t of ['Готово к пушу?', 'Готово к пушу — когда?', '**Готово к пушу** — если ревью чистое?', 'Готово к мержу, или ещё круг?',
    'Готово к пушу: можно пушить?', 'Готово к пушу — как договаривались. Пушить?', 'Готово к пушу: точно всё проверено, пушить?',
    'Готово к пушу, как и планировали: abc1234. Пушить?', 'Готово к пушу? Да, abc1234.'])
    assert.ok(isReport(t), t);
  // Accepted false block (decision 05.11): a sentence after a sign stays a report.
  assert.strictEqual(isReport('Готово к пушу, но после ревью.'), 'push');
});

test('target: a folder of the hub outside its project is no copy of it, whatever its length', () => {
  const hub = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dg-prefix-')));
  const proj = { dir: path.join(hub, 'projects', 'ai-dev-hub'), name: 'ai-dev-hub' };
  const look = path.join(hub, 'research', 'abcdefghij', 'worktrees', 'x');
  fs.mkdirSync(look, { recursive: true });
  fs.mkdirSync(path.join(proj.dir, 'worktrees', 'x', '.git'), { recursive: true });
  try {
    assert.strictEqual(target(look, 'готово', proj), null);
    assert.strictEqual(target(path.join(proj.dir, 'worktrees', 'x'), 'готово', proj), path.join(proj.dir, 'worktrees', 'x'));
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});
