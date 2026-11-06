// node --test push-slice.test.cjs — a synthetic repository with a bare remote in a temp folder; nothing leaves it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'push-slice.cjs');
// Under a git hook the caller's GIT_DIR / GIT_INDEX_FILE would send every git below into the hub's repository.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// repo (main) → bare origin; branch S-1 in its own worktree with one commit; a receipt that matches its HEAD.
function stand(t, { files = { 'src/a.js': 'module.exports = 2;\n' } } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'push-slice-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const repo = path.join(d, 'repo'), origin = path.join(d, 'origin.git'), wt = path.join(d, 'wt'), mem = path.join(d, 'mem', 'S-1');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'dev@example.test'); git(repo, 'config', 'user.name', 'dev');
  write(path.join(repo, 'src/a.js'), 'module.exports = 1;\n');
  write(path.join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  git(d, 'init', '-q', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'worktree', 'add', '-q', '-b', 'S-1', wt, 'main');
  for (const [f, s] of Object.entries(files)) write(path.join(wt, f), s);
  git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'S-1: change');
  const sha = git(wt, 'rev-parse', 'HEAD');
  const receipt = path.join(mem, 'ready.json');
  const r = { d, repo, origin, wt, mem, sha, receipt };
  r.writeReceipt = (over = {}) => writeReceipt(r, over);
  r.writeReceipt();
  r.remote = () => git(origin, 'for-each-ref', '--format=%(refname) %(objectname)');
  r.run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: ENV, cwd: d });
  r.push = (...extra) => r.run('push', repo, 'S-1', sha, '--receipt', receipt, '--base', 'main', ...extra);
  return r;
}

function writeReceipt(r, { sha = r.sha, outcome = 'ready', checksHead = r.sha, verdict = 'Блокирует: нет · CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 1', pauses = null, anomaly } = {}) {
  write(path.join(r.mem, 'checks-full.log'), `checks --full · HEAD ${checksHead} · коммитов 1\nтесты · OK · 3 с\n`);
  write(path.join(r.mem, 'review-1.md'), `Находок по логике нет.\n\n${verdict}\n`);
  fs.writeFileSync(path.join(r.mem, 'shot.png'), PNG);
  const item = (object, observation, confirmation) => ({ object, observation, confirmation });
  const receipt = {
    branch: 'S-1', sha, outcome, ...(anomaly ? { anomaly } : {}),
    pauses: pauses || {
      checks: [item('checks --full на итоговом HEAD', 'тесты OK', { output: 'checks-full.log', head: checksHead })],
      review: [item('ревью, круг 1', 'Блокирует: нет', { review: 'review-1.md' })],
      evidence: [item('Acceptance 1', 'скрин', { shot: 'shot.png' }), item('коммит реализации', 'есть в ветке', { sha })],
    },
  };
  write(r.receipt, JSON.stringify(receipt, null, 2));
}

const pushed = (r) => r.remote().includes(`refs/heads/S-1 ${r.sha}`);
const out = (res) => res.stdout + res.stderr;

test('push-slice: all gates pass — the verified sha lands on the remote branch', (t) => {
  const r = stand(t);
  const res = r.push('--solo');
  assert.strictEqual(res.status, 0, out(res));
  assert.ok(pushed(r), r.remote());
  assert.match(res.stdout, new RegExp(`запушено ${r.sha.slice(0, 7)}`));
});

test('push-slice: --dry-run runs every gate and pushes nothing', (t) => {
  const r = stand(t);
  const res = r.push('--solo', '--dry-run');
  assert.strictEqual(res.status, 0, out(res));
  assert.ok(!pushed(r));
});

test('push-slice: refuses without parallel-check (neither --wave nor --solo)', (t) => {
  const r = stand(t);
  const res = r.push();
  assert.notStrictEqual(res.status, 0, out(res));
  assert.match(out(res), /parallel-check/);
  assert.ok(!pushed(r));
});

test('push-slice: refuses when parallel-check finds a conflict with another branch of the wave', (t) => {
  const r = stand(t);
  git(r.repo, 'branch', 'S-2', 'main');
  const wt2 = path.join(r.d, 'wt2');
  git(r.repo, 'worktree', 'add', '-q', wt2, 'S-2');
  write(path.join(wt2, 'src/a.js'), 'module.exports = 3;\n');
  git(wt2, 'commit', '-q', '-am', 'S-2: other change');
  const res = r.push('--wave', 'S-2');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /КОНФЛИКТ/);
  assert.ok(!pushed(r));
});

test('push-slice: a wave without conflicts passes parallel-check', (t) => {
  const r = stand(t);
  git(r.repo, 'branch', 'S-2', 'main');
  const wt2 = path.join(r.d, 'wt2');
  git(r.repo, 'worktree', 'add', '-q', wt2, 'S-2');
  write(path.join(wt2, 'src/b.js'), 'module.exports = 3;\n');
  git(wt2, 'add', '.'); git(wt2, 'commit', '-q', '-m', 'S-2: other file');
  const res = r.push('--wave', 'S-2');
  assert.strictEqual(res.status, 0, out(res));
  assert.ok(pushed(r));
});

test('push-slice: refuses without a receipt', (t) => {
  const r = stand(t);
  fs.rmSync(r.receipt);
  const res = r.push('--solo');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /квитанц/);
  assert.ok(!pushed(r));
});

test('push-slice: refuses a receipt written for another sha', (t) => {
  const r = stand(t);
  r.writeReceipt({ sha: git(r.repo, 'rev-parse', 'main') });
  const res = r.push('--solo');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /sha/);
  assert.ok(!pushed(r));
});

test('push-slice: refuses when checks --full ran on an older HEAD', (t) => {
  const r = stand(t);
  r.writeReceipt({ checksHead: git(r.repo, 'rev-parse', 'main') });
  const res = r.push('--solo');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /checks/);
  assert.ok(!pushed(r));
});

test('push-slice: refuses when the review still blocks', (t) => {
  const r = stand(t);
  r.writeReceipt({ verdict: 'Блокирует: да · CRITICAL 0 · HIGH 1 · MEDIUM 0 · LOW 0' });
  const res = r.push('--solo');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /ревью|review/);
  assert.ok(!pushed(r));
});

test('push-slice: «Остановлено: аномалия» is a legal outcome — exit 4, nothing pushed', (t) => {
  const r = stand(t);
  r.writeReceipt({ outcome: 'anomaly', anomaly: 'полигон на ветке хуже main по H07' });
  const res = r.push('--solo');
  assert.strictEqual(res.status, 4, out(res));
  assert.match(out(res), /Остановлено: аномалия/);
  assert.match(out(res), /H07/);
  assert.ok(!pushed(r));
});

test('push-slice: a CI diff needs a separate consent (--risk-ok ci)', (t) => {
  const r = stand(t, { files: { '.gitlab-ci.yml': 'stages: [test]\n' } });
  const no = r.push('--solo');
  assert.strictEqual(no.status, 1, out(no));
  assert.match(out(no), /риск: ci/);
  assert.ok(!pushed(r));
  const partial = r.push('--solo', '--risk-ok', 'deps');
  assert.strictEqual(partial.status, 1, out(partial));
  const yes = r.push('--solo', '--risk-ok', 'ci');
  assert.strictEqual(yes.status, 0, out(yes));
  assert.ok(pushed(r));
});

test('push-slice: each risk category is named — deploy, deps, network, secrets', (t) => {
  const r = stand(t, { files: {
    'Dockerfile': 'FROM node:22\n',
    'package.json': '{"dependencies":{"left-pad":"1.3.0"}}\n',
    'src/net.js': "module.exports = () => fetch('https://api.example.test/v1');\n",
    // Built at run time: a key-shaped literal in this file would trip push-slice on the hub's own push.
    'src/conf.js': `module.exports = { apiKey: '${['sk', 'live', '0123456789abcdef'].join('_')}' };\n`,
  } });
  const res = r.push('--solo');
  assert.strictEqual(res.status, 1, out(res));
  for (const c of ['деплой', 'зависимости', 'сеть', 'секреты']) assert.match(out(res), new RegExp(`риск: ${c}|риск: [^\\n]*${c}`), c);
  assert.ok(!pushed(r));
});

test('push-slice: an ordinary diff (code, docs with links) is not a risk', (t) => {
  const r = stand(t, { files: { 'src/a.js': 'module.exports = 2;\n', 'docs/x.md': 'см. https://example.test/doc\n' } });
  const res = r.push('--solo');
  assert.strictEqual(res.status, 0, out(res));
  assert.doesNotMatch(out(res), /риск:/);
});

test('push-slice: refuses a push that is not a fast-forward of the remote branch', (t) => {
  const r = stand(t);
  const other = path.join(r.d, 'other');
  git(r.d, 'clone', '-q', r.origin, other);
  git(other, 'config', 'user.email', 'dev@example.test'); git(other, 'config', 'user.name', 'dev');
  git(other, 'switch', '-q', '-c', 'S-1');
  write(path.join(other, 'x.txt'), 'x\n');
  git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'someone else');
  git(other, 'push', '-q', 'origin', 'S-1');
  const before = r.remote();
  const res = r.push('--solo');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /fast-forward/);
  assert.strictEqual(r.remote(), before);
});

test('push-slice: a commit by another author is named and refused without --foreign-ok', (t) => {
  const r = stand(t);
  write(path.join(r.wt, 'src/c.js'), '1\n');
  git(r.wt, 'add', '.');
  git(r.wt, '-c', 'user.email=other@example.test', '-c', 'user.name=other', 'commit', '-q', '-m', 'from other');
  r.sha = git(r.wt, 'rev-parse', 'HEAD');
  r.writeReceipt();
  const res = r.run('push', r.repo, 'S-1', r.sha, '--receipt', r.receipt, '--base', 'main', '--solo');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /чуж/);
  assert.match(out(res), /other@example\.test/);
  const ok = r.run('push', r.repo, 'S-1', r.sha, '--receipt', r.receipt, '--base', 'main', '--solo', '--foreign-ok');
  assert.strictEqual(ok.status, 0, out(ok));
});

test('push-slice: a private name in any commit (diff or message) is refused — squash', (t) => {
  const r = stand(t);
  write(path.join(r.wt, 'src/d.js'), '1\n');
  git(r.wt, 'add', '.'); git(r.wt, 'commit', '-q', '-m', 'for Acmecorp client');
  write(path.join(r.wt, 'src/d.js'), '2\n');
  git(r.wt, 'commit', '-q', '-am', 'neutral');
  r.sha = git(r.wt, 'rev-parse', 'HEAD');
  r.writeReceipt();
  const pat = path.join(r.d, 'patterns');
  write(pat, '# private\nacmecorp\n');
  const res = r.run('push', r.repo, 'S-1', r.sha, '--receipt', r.receipt, '--base', 'main', '--solo', '--patterns', pat);
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /сквош/);
  assert.ok(!pushed(r));
});

test('push-slice: refuses when the branch tip is not the reported sha or its worktree is dirty', (t) => {
  const r = stand(t);
  write(path.join(r.wt, 'src/a.js'), 'dirty\n');
  const dirty = r.push('--solo');
  assert.strictEqual(dirty.status, 1, out(dirty));
  assert.match(out(dirty), /не чист|грязн/);
  git(r.wt, 'commit', '-q', '-am', 'later');
  const moved = r.push('--solo');
  assert.strictEqual(moved.status, 1, out(moved));
  assert.ok(!pushed(r));
});

test('push-slice verify: a matching receipt — one line; a mismatch — only the mismatches', (t) => {
  const r = stand(t);
  const ok = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
  assert.strictEqual(ok.status, 0, out(ok));
  assert.strictEqual(ok.stdout.trim().split('\n').length, 1, ok.stdout);
  assert.match(ok.stdout, /квитанция сходится/);
  fs.rmSync(path.join(r.mem, 'shot.png'));
  const bad = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
  assert.strictEqual(bad.status, 1, out(bad));
  assert.match(out(bad), /shot\.png/);
  assert.doesNotMatch(out(bad), /checks-full\.log/);
});

test('push-slice verify: three pause points, each 1–7 items «object → observation → confirmation»', (t) => {
  const r = stand(t);
  const item = { object: 'o', observation: 'n', confirmation: { sha: r.sha } };
  const base = JSON.parse(fs.readFileSync(r.receipt, 'utf8')).pauses;
  r.writeReceipt({ pauses: { checks: base.checks, review: base.review } });
  assert.strictEqual(r.run('verify', r.repo, 'S-1', '--receipt', r.receipt).status, 1);
  r.writeReceipt({ pauses: { ...base, evidence: Array(8).fill(item) } });
  assert.strictEqual(r.run('verify', r.repo, 'S-1', '--receipt', r.receipt).status, 1);
  r.writeReceipt({ pauses: { ...base, evidence: [{ object: 'o', confirmation: { sha: r.sha } }] } });
  assert.strictEqual(r.run('verify', r.repo, 'S-1', '--receipt', r.receipt).status, 1);
  r.writeReceipt({ pauses: { ...base, evidence: [{ object: 'o', observation: 'n', confirmation: { sha: 'deadbeefdeadbeef' } }] } });
  const ghost = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
  assert.strictEqual(ghost.status, 1, out(ghost));
  assert.match(out(ghost), /deadbeef/);
});

test('push-slice: main after a wave — every commit covered by a receipt (a merge, a squash); an unreceipted one refused', (t) => {
  const r = stand(t);
  const r1 = r.receipt;
  // S-2: its own worktree, commit and receipt; squashed into main, S-1 merged with --no-ff.
  const wt2 = path.join(r.d, 'wt2'), mem2 = path.join(r.d, 'mem', 'S-2');
  git(r.repo, 'worktree', 'add', '-q', '-b', 'S-2', wt2, 'main');
  write(path.join(wt2, 'src/b.js'), 'module.exports = 3;\n');
  git(wt2, 'add', '.'); git(wt2, 'commit', '-q', '-m', 'S-2: b');
  const s2 = { ...r, mem: mem2, sha: git(wt2, 'rev-parse', 'HEAD'), receipt: path.join(mem2, 'ready.json') };
  writeReceipt(s2, {});
  const rec2 = JSON.parse(fs.readFileSync(s2.receipt, 'utf8')); rec2.branch = 'S-2'; write(s2.receipt, JSON.stringify(rec2));
  git(r.repo, 'merge', '-q', '--no-ff', '-m', 'merge S-1', 'S-1');
  git(r.repo, 'merge', '-q', '--squash', 'S-2'); git(r.repo, 'commit', '-q', '-m', 'S-2 (squash)');
  const main = git(r.repo, 'rev-parse', 'main');
  const remoteMain = () => r.remote().includes(`refs/heads/main ${main}`);
  const both = r.run('push', r.repo, 'main', main, '--receipt', r1, '--receipt', s2.receipt, '--base', 'origin/main', '--solo', '--integration');
  assert.strictEqual(both.status, 0, out(both));
  assert.ok(remoteMain());
  // A hand commit on main without a receipt — refused.
  write(path.join(r.repo, 'src/c.js'), '1\n');
  git(r.repo, 'add', '.'); git(r.repo, 'commit', '-q', '-m', 'hand fix');
  const next = git(r.repo, 'rev-parse', 'main');
  const res = r.run('push', r.repo, 'main', next, '--receipt', r1, '--receipt', s2.receipt, '--base', 'origin/main', '--solo', '--integration');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /без квитанции[\s\S]*hand fix/);
});

test('push-slice: after a rebase — only with --lease <the remote tip the user agreed to replace>', (t) => {
  const r = stand(t);
  assert.strictEqual(r.push('--solo').status, 0);
  const old = r.sha;
  // main moves on, S-1 is rebased onto it: the new tip is not a fast-forward of origin/S-1.
  write(path.join(r.repo, 'README.md'), '# demo 2\n');
  git(r.repo, 'commit', '-q', '-am', 'main moves');
  git(r.repo, 'push', '-q', 'origin', 'main');
  git(r.wt, 'rebase', '-q', 'main');
  r.sha = git(r.wt, 'rev-parse', 'HEAD');
  r.writeReceipt();
  const args = (...x) => r.run('push', r.repo, 'S-1', r.sha, '--receipt', r.receipt, '--base', 'main', '--solo', ...x);
  const plain = args();
  assert.strictEqual(plain.status, 1, out(plain));
  assert.match(out(plain), /fast-forward[\s\S]*--lease/);
  const wrong = args('--lease', git(r.repo, 'rev-parse', 'main'));
  assert.strictEqual(wrong.status, 1, out(wrong));
  assert.ok(r.remote().includes(`refs/heads/S-1 ${old}`));
  const ok = args('--lease', old.slice(0, 9));
  assert.strictEqual(ok.status, 0, out(ok));
  assert.ok(pushed(r), r.remote());
});

test('push-slice verify: last-full (slice 16) — full sha of HEAD, code 0, clean tree; anything else is a mismatch', (t) => {
  const r = stand(t);
  const base = JSON.parse(fs.readFileSync(r.receipt, 'utf8')).pauses;
  const lf = path.join(r.mem, 'last-full.json');
  const withStamp = (stamp) => {
    write(lf, JSON.stringify({ at: '2026-11-05T10:00:00Z', base: 'main', steps: [{ name: 'tests', status: 'OK' }], ...stamp }));
    r.writeReceipt({ pauses: { ...base, checks: [{ object: 'checks --full', observation: 'OK', confirmation: { 'last-full': 'last-full.json' } }] } });
    return r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
  };
  assert.strictEqual(withStamp({ sha: r.sha, code: 0, clean: true }).status, 0);
  for (const bad of [{ sha: r.sha.slice(0, 12), code: 0, clean: true }, { sha: r.sha, code: 1, clean: true },
    { sha: r.sha, code: 0, clean: false }, { sha: r.sha, code: 0 }, { head: r.sha, code: 0, clean: true }]) {
    const res = withStamp(bad);
    assert.strictEqual(res.status, 1, `${JSON.stringify(bad)}: ${out(res)}`);
    assert.match(out(res), /last-full/);
  }
});

// Review round 1 (05.11): gates that let the wrong thing through.
test('push-slice: a slice push needs the receipt of THAT branch — a receipt of another branch on the same commit is not one', (t) => {
  const r = stand(t);
  git(r.repo, 'branch', 'B', 'S-1');
  const rec = JSON.parse(fs.readFileSync(r.receipt, 'utf8')); rec.branch = 'B'; write(r.receipt, JSON.stringify(rec));
  const res = r.push('--solo');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /квитанц[^\n]*S-1/);
  assert.ok(!pushed(r));
  const integ = r.push('--solo', '--integration');
  assert.notStrictEqual(integ.status, 0, out(integ)); // --integration — только для ветки, которую называет --base
  assert.ok(!pushed(r));
});

test('push-slice: commits of the base not yet on the remote do not ride along with a slice', (t) => {
  const d = stand(t);
  write(path.join(d.repo, 'notes.md'), 'unpushed base\n');
  git(d.repo, 'add', '.'); git(d.repo, 'commit', '-q', '-m', 'base note');
  git(d.wt, 'rebase', '-q', 'main');
  d.sha = git(d.wt, 'rev-parse', 'HEAD');
  d.writeReceipt();
  const res = d.run('push', d.repo, 'S-1', d.sha, '--receipt', d.receipt, '--base', 'main', '--solo');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /base note/);
  assert.ok(!d.remote().includes('refs/heads/S-1'));
});

test('push-slice: the base moving on after the branch point is not the slice\'s risk', (t) => {
  const r = stand(t);
  write(path.join(r.repo, 'package.json'), '{"dependencies":{"x":"1"}}\n');
  git(r.repo, 'add', '.'); git(r.repo, 'commit', '-q', '-m', 'base: deps');
  git(r.repo, 'push', '-q', 'origin', 'main');
  const res = r.push('--solo');
  assert.strictEqual(res.status, 0, out(res));
  assert.doesNotMatch(out(res), /риск/);
});

test('push-slice: a private name in a file path or in the author is found too', (t) => {
  const r = stand(t);
  write(path.join(r.wt, 'acmecorp-plan.md'), '');
  git(r.wt, 'add', '.'); git(r.wt, 'commit', '-q', '-m', 'plan');
  r.sha = git(r.wt, 'rev-parse', 'HEAD'); r.writeReceipt();
  const pat = path.join(r.d, 'patterns'); write(pat, 'acmecorp\n');
  const res = r.run('push', r.repo, 'S-1', r.sha, '--receipt', r.receipt, '--base', 'main', '--solo', '--patterns', pat);
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /сквош/);
});

test('push-slice verify: a checks log with FAIL is not a green run, even on HEAD', (t) => {
  const r = stand(t);
  r.writeReceipt();
  fs.appendFileSync(path.join(r.mem, 'checks-full.log'), 'полигон · FAIL · 12 с\n');
  const res = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /FAIL/);
});

test('push-slice: no user.email — the foreign-author gate cannot decide: exit 3, not a pass', (t) => {
  const r = stand(t);
  git(r.repo, 'config', '--unset', 'user.email');
  const home = path.join(r.d, 'home'); fs.mkdirSync(home);
  const res = spawnSync(process.execPath, [SCRIPT, 'push', r.repo, 'S-1', r.sha, '--receipt', r.receipt, '--base', 'main', '--solo'],
    { encoding: 'utf8', env: { ...ENV, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.strictEqual(res.status, 3, out(res));
  assert.ok(!pushed(r));
});

test('push-slice: a receipt that is JSON null — a mismatch (1), not a crash', (t) => {
  const r = stand(t);
  write(r.receipt, 'null');
  for (const res of [r.run('verify', r.repo, 'S-1', '--receipt', r.receipt), r.push('--solo')]) {
    assert.strictEqual(res.status, 1, out(res));
    assert.doesNotMatch(out(res), /TypeError/);
  }
});

// Review round 2 (05.11).
test('push-slice: --base origin/main — unpushed commits of local main still do not ride along', (t) => {
  const d = stand(t);
  write(path.join(d.repo, 'notes.md'), 'unpushed base\n');
  git(d.repo, 'add', '.'); git(d.repo, 'commit', '-q', '-m', 'base note');
  git(d.wt, 'rebase', '-q', 'main');
  d.sha = git(d.wt, 'rev-parse', 'HEAD');
  d.writeReceipt();
  const res = d.run('push', d.repo, 'S-1', d.sha, '--receipt', d.receipt, '--base', 'origin/main', '--solo');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /base note/);
});

test('push-slice: what a merge adds beyond its parents is read too — risk and names', (t) => {
  const r = stand(t);
  git(r.repo, 'branch', 'side', 'main');
  const wt2 = path.join(r.d, 'wt2');
  git(r.repo, 'worktree', 'add', '-q', wt2, 'side');
  write(path.join(wt2, 'src/b.js'), '1\n'); git(wt2, 'add', '.'); git(wt2, 'commit', '-q', '-m', 'side');
  git(r.wt, 'merge', '-q', '--no-ff', '--no-commit', 'side');
  write(path.join(r.wt, '.gitlab-ci.yml'), 'stages: [x]\n');
  write(path.join(r.wt, 'n.md'), 'for acmecorp\n');
  git(r.wt, 'add', '.'); git(r.wt, 'commit', '-q', '-m', 'merge side');
  r.sha = git(r.wt, 'rev-parse', 'HEAD'); r.writeReceipt();
  const pat = path.join(r.d, 'patterns'); write(pat, 'acmecorp\n');
  const res = r.run('push', r.repo, 'S-1', r.sha, '--receipt', r.receipt, '--base', 'main', '--solo', '--patterns', pat, '--risk-ok', 'ci');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /сквош/);
  const noPat = r.run('push', r.repo, 'S-1', r.sha, '--receipt', r.receipt, '--base', 'main', '--solo', '--dry-run');
  assert.match(out(noPat), /риск: ci/);
});

test('push-slice verify: pytest FAILED, «1 failed», mocha «2 failing» — not a green log; «0 failed» is', (t) => {
  const r = stand(t);
  for (const [line, red] of [['FAILED tests/test_x.py::test_a - assert 1 == 2', true], ['===== 1 failed, 3 passed =====', true],
    ['  2 failing', true], ['Test Files  1 failed | 4 passed', true], ['tests 6 · pass 6 · fail 0 · 0 failed', false]]) {
    r.writeReceipt();
    fs.appendFileSync(path.join(r.mem, 'checks-full.log'), line + '\n');
    const res = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
    assert.strictEqual(res.status, red ? 1 : 0, `${line}: ${out(res)}`);
  }
});

// Review round 3 (05.11) — fixed without a review round (rule 8).
test('push-slice: an octopus merge (3+ parents) cannot be read by --remerge-diff — refused, not passed', (t) => {
  const r = stand(t);
  for (const b of ['s1', 's2']) {
    git(r.repo, 'branch', b, 'main');
    const w = path.join(r.d, `w-${b}`);
    git(r.repo, 'worktree', 'add', '-q', w, b);
    write(path.join(w, `${b}.js`), '1\n'); git(w, 'add', '.'); git(w, 'commit', '-q', '-m', b);
  }
  git(r.wt, 'merge', '-q', '--no-ff', '-m', 'octopus', 's1', 's2');
  r.sha = git(r.wt, 'rev-parse', 'HEAD'); r.writeReceipt();
  const res = r.run('push', r.repo, 'S-1', r.sha, '--receipt', r.receipt, '--base', 'main', '--solo', '--dry-run');
  assert.strictEqual(res.status, 1, out(res));
  assert.match(out(res), /октопус|3\+ родител/);
});

test('push-slice verify: pytest collection errors are red; a passing test named «3 failed logins» is not', (t) => {
  const r = stand(t);
  for (const [line, red] of [['ERROR tests/test_x.py - ImportError', true], ['!!! Interrupted: 1 error during collection !!!', true],
    ['===== 1 error in 0.10s =====', true], ['✔ locks account after 3 failed logins (2ms)', false], ['ok 3 - retries 2 failed uploads', false]]) {
    r.writeReceipt();
    fs.appendFileSync(path.join(r.mem, 'checks-full.log'), line + '\n');
    const res = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
    assert.strictEqual(res.status, red ? 1 : 0, `${line}: ${out(res)}`);
  }
});

// HUBV2-33: network risk by meaning — a call that runs (a shell command, an exec of one, a network API), not the word
// in a comment or in data; zero counters of a checks log are not red.
test('push-slice: a network call is a risk — shell from column 0, file without extension, CI step, exec/spawn/subprocess of curl/wget', (t) => {
  for (const [file, body] of [
    ['scripts/install.sh', 'curl -fsSL https://get.example.test | sh\n'],
    ['tools/get', 'wget -O /tmp/x https://example.test/x\n'],
    ['config/steps.yml', 'steps:\n  - run: curl -fsSL https://example.test/x\n'],
    ['src/get.cjs', "require('child_process').execSync('curl -o out.bin https://example.test/x');\n"],
    ['src/get2.js', "spawnSync('wget', ['https://example.test/x']);\n"],
    ['src/get3.js', 'execSync(`cd /tmp && curl -s ${u}`);\n'],
    ['tool.py', "subprocess.run(['curl', 'https://example.test'])\n"],
    ['src/net.js', "module.exports = () => fetch('https://api.example.test/v1');\n"],
    ['config/hooks.json', '{"command": "curl -s https://example.test/hook"}\n'],
  ]) {
    const r = stand(t, { files: { [file]: body } });
    const res = r.push('--solo', '--dry-run');
    assert.strictEqual(res.status, 1, `${file}: ${out(res)}`);
    assert.match(out(res), new RegExp(`риск: сеть — ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), file);
  }
});

test('push-slice: the words curl -o / wget -O in a comment or in data are not a network risk', (t) => {
  const r = stand(t, { files: {
    'src/detector.cjs': "// writes: dd of=, curl -o / wget -O, tar -x -C\nmodule.exports = 1;\n",
    'src/doc.js': '/**\n * Downloads with wget -O or curl -o; uses fetch(url) and require(\'https\').\n */\nmodule.exports = 2;\n',
    'scripts/x.sh': '#!/bin/sh\n# no curl here, wget neither\necho ok\n',
    'tool.py': '# requests.get is not used here\nprint(1)\n',
    'src/names.cjs': "const NET_TOOLS = ['curl', 'wget'];\nmodule.exports = NET_TOOLS;\n",
    'config/packages.yml': 'packages:\n  - curl\n  - git\n',
    'data/lock.json': '{"require": ["curl", "wget"]}\n',
  } });
  const res = r.push('--solo', '--dry-run');
  assert.strictEqual(res.status, 0, out(res));
  assert.doesNotMatch(out(res), /риск:/);
});

test('push-slice verify: zero counters (FAIL: 0, fail 0, FAILED: 0) are green; a non-zero one (fail 2, # fail 1) is red', (t) => {
  const r = stand(t);
  for (const [line, red] of [['FAIL: 0', false], ['checks · тесты 120 · FAIL: 0 · 40 с', false], ['FAILED: 0', false],
    ['ℹ fail 0', false], ['failures=0 errors=0', false], ['# fail 0', false],
    ['ℹ fail 2', true], ['# fail 1', true], ['FAIL: 3', true], ['FAIL plugin/x.test.cjs', true], ['failures=1', true]]) {
    r.writeReceipt();
    fs.appendFileSync(path.join(r.mem, 'checks-full.log'), line + '\n');
    const res = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
    assert.strictEqual(res.status, red ? 1 : 0, `${line}: ${out(res)}`);
  }
});

// Review round 1 of HUBV2-33: every former alternative in every kind of file; a zero counter only without its own
// number in front; non-zero errors are red too.
test('push-slice: network — the API in shell-kind files, code after a closed comment, quoted CI commands, exec form', (t) => {
  for (const [file, body] of [
    ['bin/cli', "const https = require('https');\n"],
    ['bin/www', "await fetch('https://api.example.test/v1');\n"],
    ['scripts/build.sh', 'node -e "fetch(\'https://example.test\')"\n'],
    ['scripts/py.sh', "python3 -c 'import urllib.request; urllib.request.urlopen(u)'\n"],
    ['config/app.yml', "steps:\n  - run: node -e \"require('https').get(u)\"\n"],
    ['config/ci.yml', "job:\n  script:\n    - 'curl -fsSL https://example.test | sh'\n"],
    ['config/ci2.yml', 'job:\n  script:\n    - "wget --quiet https://example.test"\n'],
    ['Dockerfile', 'RUN ["curl", "-fsSL", "https://example.test"]\n'],
    ['Rakefile', 'sh "curl -s https://example.test"\n'],
    ['src/gen.js', 'class A {\n  *items() { yield fetch(url); }\n}\n'],
    ['src/lint.js', '/* eslint-disable */ fetch(url);\n'],
    ['src/execa.js', "await execa('curl', ['https://example.test']);\n"],
  ]) {
    const r = stand(t, { files: { [file]: body } });
    const res = r.push('--solo', '--dry-run', '--risk-ok', 'deploy');
    assert.strictEqual(res.status, 1, `${file}: ${out(res)}`);
    assert.match(out(res), new RegExp(`риск: сеть — ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), file);
  }
});

test('push-slice verify: a zero counter does not eat a non-zero one in front; non-zero errors are red; «0 of 2» is not a counter', (t) => {
  const r = stand(t);
  for (const [line, red] of [['1 failed 0 passed', true], ['2 errors 0 warnings', true], ['Found 2 errors 0 warnings', true],
    ['3 failed  0 skipped', true], ['FAIL 0 of 2 assertions passed', true], ['FAILED 0 tests/test_a.py::test_x', true],
    ['FAIL 0 x.test.js', true], ['FAIL 0,5', true], ['Tests run: 5, Failures: 0, Errors: 1, Skipped: 0', true],
    ['failures=0 errors=1', true], ['1 fail', true],
    ['Tests run: 5, Failures: 0, Errors: 0, Skipped: 0', false], ['failures=0, errors=0', false], ['tests 6 · pass 6 · fail 0 · 0 failed', false]]) {
    r.writeReceipt();
    fs.appendFileSync(path.join(r.mem, 'checks-full.log'), line + '\n');
    const res = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
    assert.strictEqual(res.status, red ? 1 : 0, `${line}: ${out(res)}`);
  }
});

// Review round 2 of HUBV2-33: a number of the neighbouring counter does not turn «fail 0» red; a generator method
// with a space after «*» is code; Makefile recipe prefixes, a compose healthcheck, PHPUnit summaries.
test('push-slice verify: a one-line summary without separators — «pass 6 fail 0» is green; PHPUnit Failures: 1. and FAILURES! are red', (t) => {
  const r = stand(t);
  for (const [line, red] of [['A: pass 15 fail 0 · 15 db=wt_a · too many clients: 0', false], ['pass=6 fail=0', false],
    ['tests 6 failures 0', false], ['duration_ms 12 fail 0', false], ['pass 6 fail 0 skip 1', false],
    ['1 failed 0 passed', true], ['Tests: 5, Assertions: 10, Failures: 1.', true], ['FAILURES!', true], [' 1 fail', true]]) {
    r.writeReceipt();
    fs.appendFileSync(path.join(r.mem, 'checks-full.log'), line + '\n');
    const res = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
    assert.strictEqual(res.status, red ? 1 : 0, `${line}: ${out(res)}`);
  }
});

test('push-slice: network — «  * items()» generator, Makefile @curl / -wget, compose ["CMD", "curl", …], RUN ["curl", "$URL"]', (t) => {
  for (const [file, body] of [
    ['src/gen2.js', 'class A {\n  * items() { yield fetch(url); }\n}\n'],
    ['Makefile', 'get:\n\t@curl -s https://example.test/x\n'],
    ['build.mk', 'get:\n\t-wget -q https://example.test/x\n'],
    ['config/compose.yml', 'healthcheck:\n  test: ["CMD", "curl", "-f", "http://localhost"]\n'],
    ['Dockerfile', 'RUN ["curl", "$URL"]\n'],
  ]) {
    const r = stand(t, { files: { [file]: body } });
    const res = r.push('--solo', '--dry-run', '--risk-ok', 'deploy');
    assert.strictEqual(res.status, 1, `${file}: ${out(res)}`);
    assert.match(out(res), new RegExp(`риск: сеть — ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), file);
  }
  const r = stand(t, { files: { 'src/doc2.js': '/**\n * fetch(url) returns the body; see {@link https://example.test}.\n * @param {string} url\n */\nmodule.exports = 1;\n' } });
  const res = r.push('--solo', '--dry-run');
  assert.strictEqual(res.status, 0, out(res));
});

// Review round 3 of HUBV2-33 (fixed without a review round, rule 8): «N failures» anywhere in the line is red unless
// a number of its own follows; a number in front of «word: 0» keeps the counter unless the zero ends it; one-line
// generators in every shape are code.
test('push-slice verify: «3 failures» mid-line is red, «2 errors: 0 warnings» stays red, «pass=6 fail=0» stays green', (t) => {
  const r = stand(t);
  for (const [line, red] of [['10 examples, 3 failures', true], ['1 example, 1 failure', true],
    ['10 runs, 20 assertions, 3 failures, 0 errors, 0 skips', true], ['Summary: 4 passed, 2 failures', true], ['pass 5 · 1 fail', true],
    ['5 pass 1 fail', true], ['2 errors: 0 warnings', true], ['Found 2 errors: 0 fixable', true], ['1 failed: 0 passed', true],
    ['1 failed=0 skipped', true], ['10 runs, 20 assertions, 0 failures, 0 errors, 0 skips', false], ['pass=6 fail=0', false],
    ['pass 6 fail 0 skip 1', false], ['A: pass 15 fail 0 · 15 db=wt_a · too many clients: 0', false], ['tests 6 failures 0', false]]) {
    r.writeReceipt();
    fs.appendFileSync(path.join(r.mem, 'checks-full.log'), line + '\n');
    const res = r.run('verify', r.repo, 'S-1', '--receipt', r.receipt);
    assert.strictEqual(res.status, red ? 1 : 0, `${line}: ${out(res)}`);
  }
});

test('push-slice: network — one-line generators with a space after «*» in every shape are code, a JSDoc line is not', (t) => {
  for (const [i, line] of ['  * items(): Generator<Promise<Response>> { yield fetch(url); }', '  * items(a = f()) { yield fetch(url); }',
    '  * [Symbol.iterator]() { yield fetch(url); }', '  * #items() { yield fetch(url); }', '  * items<T>() { yield fetch(url); }'].entries()) {
    const file = `src/g${i}.ts`;
    const r = stand(t, { files: { [file]: `class A {\n${line}\n}\n` } });
    const res = r.push('--solo', '--dry-run');
    assert.strictEqual(res.status, 1, `${line}: ${out(res)}`);
    assert.match(out(res), new RegExp(`риск: сеть — src/g${i}\\.ts`), line);
  }
  const r = stand(t, { files: { 'src/doc3.ts': '/**\n * fetch(url) returns the body; see {@link https://example.test}.\n * Example: await fetch(url)\n */\nexport const a = 1;\n' } });
  const res = r.push('--solo', '--dry-run');
  assert.strictEqual(res.status, 0, out(res));
});
