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

test('target: the worktree the report names, else the copy of the cwd; the project folder itself — none', () => {
  const p = project();
  const w3 = p.wt('K-3'), w7 = p.wt('K-7');
  assert.strictEqual(target(w3, 'Готово к пушу: работа в worktrees/K-7, HEAD abc', p.proj), w7);
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
