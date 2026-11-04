// node --test snapshot.test.cjs
// Snapshot of hub data (snapshot.py) on a synthetic hub: journals, project memory and configs, research, repos.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'snapshot.py');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
// Fake secrets are assembled at run time: no token-shaped literal sits in the public repo.
const FAKE_GH = 'gh' + 'p_' + 'Q'.repeat(36);
const FAKE_ENV = 'SHOP_API_TOKEN=' + 'fake-eval-token-' + '9f8e7d6c5b4a3210';
// Code and prose that only look like assignments: the real journals are full of them (snapshot 05.11: 312 files).
const NOT_SECRETS = ['const token = data.accessToken;', 'password: \'Неверный пароль\'', 'token: `${prefix}-x`',
  'api_key = os.environ.get("API_KEY")', 'secret: process.env.SESSION_SECRET', 'token=abcdefghijklmnopqrstu',
  'token = config.v2.authToken', '"output_tokens":12345', 'token_count: 5000'].join('\n');
// Plain passwords and keys must still be found: one per line, every line counts.
const PASSWORDS = ['DB_PASSWORD=s3cr3tP@ss', 'password=Sup3r$ecretPass!2024', 'POSTGRES_PASSWORD=hunter2hunter2',
  'password = "Tr0ub4dor&3horse"', 'API_TOKEN=Abcd1234Efgh5678IJKL.', 'SECRET_KEY=insecure-9x8y7z6w5v4u'].join('\n');

const initRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
};
const commit = (dir, file, text) => { write(path.join(dir, file), text); git(dir, 'add', '--', file); git(dir, 'commit', '-q', '-m', file); };

// A hub with two projects. p1: memory, configs, plan, repo/ with a stash, a local-only branch, a worktree with
// uncommitted work. p2: memory and a site/ repo. Journals: two project folders, a subagent journal.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journals = path.join(root, 'claude-projects');
  const hub = path.join(root, 'hub');
  const dest = path.join(root, 'hub-data');
  write(path.join(journals, 'proj-a', 's1.jsonl'), '{"type":"user","message":"hi"}\n');
  write(path.join(journals, 'proj-a', 's1', 'subagents', 'agent-1.jsonl'), '{"type":"assistant"}\n');
  write(path.join(journals, 'proj-b', 's2.jsonl'), `{"type":"user","message":"key ${FAKE_GH}"}\n`);

  initRepo(hub);
  write(path.join(hub, '.gitignore'), 'projects/\nresearch/\nideas/\nCLAUDE.local.md\n.githooks/private-patterns\n');
  commit(hub, 'CLAUDE.md', 'rules\n');
  git(hub, 'add', '.gitignore'); git(hub, 'commit', '-q', '-m', 'ignore');
  write(path.join(hub, '.githooks', 'private-patterns'), 'secretname\n');
  write(path.join(hub, 'CLAUDE.local.md'), 'personal\n');
  write(path.join(hub, 'research', 'r.md'), 'research\n');
  write(path.join(hub, 'research', 'proto', 'data.bin'), Buffer.from([0, 1, 2, 255, 0]));
  write(path.join(hub, 'ideas', 'i.md'), 'idea\n');

  const p1 = path.join(hub, 'projects', 'p1');
  write(path.join(p1, 'CLAUDE.md'), 'p1 knowledge\n');
  write(path.join(p1, 'rules.json'), '{"rules":[]}\n');
  write(path.join(p1, 'dispatch-rules.json'), '{}\n');
  write(path.join(p1, 'checks.json'), '{}\n');
  write(path.join(p1, 'brief.json'), '{}\n');
  write(path.join(p1, 'dispatch-profile.md'), 'profile\n');
  write(path.join(p1, 'plan', 'plan.md'), 'plan\n');
  write(path.join(p1, '.claude', 'launch.json'), '{}\n');
  write(path.join(p1, 'memory', 'errors.md'), 'errors\n');
  write(path.join(p1, 'memory', 'rules-guard.log'), '{"rule":"x"}\n');
  write(path.join(p1, 'memory', 'dispatch-guard.log'), '{"kind":"heavy"}\n');
  write(path.join(p1, 'memory', 'dispatch-grants.json'), '{}\n');
  write(path.join(p1, 'memory', 'task-1', 'shot.png'), Buffer.from([137, 80, 78, 71, 0, 0, 7]));
  write(path.join(p1, 'memory', 'task-1', '.env.example'), FAKE_ENV + '\n');
  write(path.join(p1, 'memory', 'task-1', 'code-notes.md'), NOT_SECRETS + '\n');
  const repo = path.join(p1, 'repo');
  initRepo(repo);
  commit(repo, 'a.txt', 'a\n');
  git(repo, 'branch', 'local-only');
  write(path.join(repo, 'a.txt'), 'stashed\n'); git(repo, 'stash', 'push', '-q', '-m', 'wip-stash');
  git(repo, 'worktree', 'add', '-q', '-b', 'TASK-1', path.join(p1, 'worktrees', 'TASK-1'));
  write(path.join(p1, 'worktrees', 'TASK-1', 'a.txt'), 'uncommitted\n');

  const p2 = path.join(hub, 'projects', 'p2');
  write(path.join(p2, 'memory', 'sessions', 'n.md'), 'note\n');
  initRepo(path.join(p2, 'site'));
  commit(path.join(p2, 'site'), 'index.html', '<p>\n');
  return { root, journals, hub, dest };
}

// No __pycache__ next to the script: it is not a part of the hub's git.
const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
const run = (fx, ...extra) => spawnSync('python3',
  [SCRIPT, '--dest', fx.dest, '--journals', fx.journals, '--hub', fx.hub, ...extra], { encoding: 'utf8', env: ENV });
const runInterrupted = (fx) => spawnSync('python3',
  [SCRIPT, '--dest', fx.dest, '--journals', fx.journals, '--hub', fx.hub],
  { encoding: 'utf8', env: { ...ENV, HUB_DATA_INTERRUPT: 'after-copy' } });
const verify = (fx) => spawnSync('python3', [SCRIPT, '--verify', fx.dest], { encoding: 'utf8', env: ENV });
const ok = (r) => { assert.strictEqual(r.status, 0, r.stdout + r.stderr); return r.stdout; };
const reportOf = (out) => fs.readFileSync(out.match(/^отчёт: (.+)$/m)[1], 'utf8');
const manifest = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').trim().split('\n')
  .map((l) => { const m = l.match(/^([0-9a-f]{64}) {2}(.+)$/); return [m[2], m[1]]; }));
const files = (dir) => fs.readdirSync(dir, { recursive: true }).map(String)
  .filter((f) => fs.lstatSync(path.join(dir, f)).isFile()).sort();
// Every file and dir under a tree with size and mtime: a source that was only read keeps this list as it was.
const stamp = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort().map((f) => {
  const s = fs.lstatSync(path.join(dir, f));
  return `${f} ${s.isDirectory() ? 'd' : s.size} ${s.mtimeMs}`;
});

test('snapshot: journals copied whole, MANIFEST.sha256 matches the copy, dest is private (700)', (t) => {
  const fx = fixture(t);
  const out = ok(run(fx));
  const copy = path.join(fx.dest, 'journals');
  assert.deepStrictEqual(files(copy).filter((f) => f !== 'MANIFEST.sha256'), files(fx.journals));
  const m = manifest(path.join(copy, 'MANIFEST.sha256'));
  assert.deepStrictEqual(Object.keys(m).sort(), files(fx.journals));
  for (const f of files(fx.journals)) assert.strictEqual(m[f], sha(path.join(fx.journals, f)), f);
  assert.strictEqual(fs.statSync(fx.dest).mode & 0o777, 0o700);
  assert.match(out, /^журналы: файлов 3, новых 3, изменённых 0/m);
  const v = ok(verify(fx));
  assert.match(v, /^журналы: манифест сходится 3 из 3 \(100%\)/m);
});

test('snapshot: a repeat reports «0 новых», then lists only the new and the changed journal', (t) => {
  const fx = fixture(t);
  ok(run(fx));
  assert.match(ok(run(fx)), /^журналы: 0 новых, 0 изменённых/m);
  write(path.join(fx.journals, 'proj-c', 's3.jsonl'), '{"new":1}\n');
  fs.appendFileSync(path.join(fx.journals, 'proj-a', 's1.jsonl'), '{"more":1}\n');
  const out = ok(run(fx));
  assert.match(out, /^журналы: файлов 4, новых 1, изменённых 1/m);
  assert.match(out, /^ {2}\+ proj-c\/s3\.jsonl$/m);
  assert.match(out, /^ {2}~ proj-a\/s1\.jsonl$/m);
  assert.doesNotMatch(out, /proj-b\/s2\.jsonl/);
  assert.strictEqual(sha(path.join(fx.dest, 'journals', 'proj-a', 's1.jsonl')), sha(path.join(fx.journals, 'proj-a', 's1.jsonl')));
  assert.match(ok(verify(fx)), /манифест сходится 4 из 4 \(100%\)/);
});

test('snapshot: a journal removed from the source (cleanup) stays in the copy and in the manifest', (t) => {
  const fx = fixture(t);
  ok(run(fx));
  fs.rmSync(path.join(fx.journals, 'proj-b'), { recursive: true });
  const out = ok(run(fx));
  assert.match(out, /пропало в источнике 1/);
  assert.ok(fs.existsSync(path.join(fx.dest, 'journals', 'proj-b', 's2.jsonl')));
  assert.match(ok(verify(fx)), /манифест сходится 3 из 3 \(100%\)/);
});

test('verify: a damaged or missing copy fails and is named; a source changed after the snapshot is only noted', (t) => {
  const fx = fixture(t);
  ok(run(fx));
  fs.appendFileSync(path.join(fx.journals, 'proj-a', 's1.jsonl'), '{"later":1}\n');
  const later = verify(fx);
  assert.strictEqual(later.status, 0, later.stdout + later.stderr);
  assert.match(later.stdout, /изменено в источнике после снимка 1/);
  fs.writeFileSync(path.join(fx.dest, 'journals', 'proj-b', 's2.jsonl'), 'broken\n');
  fs.rmSync(path.join(fx.dest, 'hub', 'projects', 'p1', 'memory', 'errors.md'));
  const bad = verify(fx);
  assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^журналы: манифест сходится 2 из 3 \(66\.6%\)/m);
  assert.match(bad.stdout, /proj-b\/s2\.jsonl/);
  assert.match(bad.stdout, /projects\/p1\/memory\/errors\.md/);
});

test('snapshot: memory, configs, logs, plan and research copied byte for byte; repos and worktrees are not', (t) => {
  const fx = fixture(t);
  ok(run(fx));
  const copy = path.join(fx.dest, 'hub');
  const expected = [
    '.githooks/private-patterns', 'CLAUDE.local.md', 'ideas/i.md', 'research/proto/data.bin', 'research/r.md',
    'projects/p1/.claude/launch.json', 'projects/p1/CLAUDE.md', 'projects/p1/brief.json', 'projects/p1/checks.json',
    'projects/p1/dispatch-profile.md', 'projects/p1/dispatch-rules.json', 'projects/p1/memory/dispatch-grants.json',
    'projects/p1/memory/dispatch-guard.log', 'projects/p1/memory/errors.md', 'projects/p1/memory/rules-guard.log',
    'projects/p1/memory/task-1/.env.example', 'projects/p1/memory/task-1/code-notes.md',
    'projects/p1/memory/task-1/shot.png', 'projects/p1/plan/plan.md',
    'projects/p1/rules.json', 'projects/p2/memory/sessions/n.md',
  ].sort();
  assert.deepStrictEqual(files(copy).filter((f) => f !== 'MANIFEST.sha256'), expected);
  for (const f of expected) assert.ok(fs.readFileSync(path.join(copy, f)).equals(fs.readFileSync(path.join(fx.hub, f))), f);
  assert.deepStrictEqual(Object.keys(manifest(path.join(copy, 'MANIFEST.sha256'))).sort(), expected);
  assert.match(ok(verify(fx)), /^хаб: манифест сходится 21 из 21 \(100%\)/m);
});

test('snapshot: repos bundled with --all and pass git bundle verify; report lists stash, local branches, dirty worktrees', (t) => {
  const fx = fixture(t);
  const out = ok(run(fx));
  const bundles = path.join(fx.dest, 'bundles');
  assert.deepStrictEqual(fs.readdirSync(bundles).filter((f) => f.endsWith('.bundle')).sort(),
    ['hub.bundle', 'p1--repo.bundle', 'p2--site.bundle']);
  const bare = path.join(fx.root, 'verify.git');
  git(fx.root, 'init', '-q', '--bare', bare);
  for (const b of ['hub.bundle', 'p1--repo.bundle', 'p2--site.bundle']) git(bare, 'bundle', 'verify', '-q', path.join(bundles, b));
  const heads = git(bare, 'bundle', 'list-heads', path.join(bundles, 'p1--repo.bundle'));
  for (const ref of ['refs/heads/main', 'refs/heads/local-only', 'refs/heads/TASK-1', 'refs/stash']) assert.match(heads, new RegExp(ref));
  const rep = reportOf(out);
  assert.match(rep, /wip-stash/);
  assert.match(rep, /local-only/);
  assert.match(rep, /TASK-1[\s\S]*a\.txt/);
  assert.match(out, /^бандлы: 3, verify ok 3 из 3/m);
  assert.match(ok(verify(fx)), /^бандлы: verify ok 3 из 3/m);
});

test('snapshot: sources are only read — every file and mtime under the hub and the journals is unchanged', (t) => {
  const fx = fixture(t);
  // Plain git status may refresh the index: taken before the stamp, so only the snapshot is measured.
  const status = git(path.join(fx.hub, 'projects', 'p1', 'repo'), 'status', '--porcelain=v1', '-b');
  const before = [stamp(fx.hub), stamp(fx.journals)];
  const out = ok(run(fx));
  ok(run(fx));
  assert.deepStrictEqual([stamp(fx.hub), stamp(fx.journals)], before);
  assert.strictEqual(git(path.join(fx.hub, 'projects', 'p1', 'repo'), 'status', '--porcelain=v1', '-b'), status);
  assert.match(out, /^источники: git status до и после совпадает \(4 из 4\)/m);
});

test('snapshot: secret scan lists files and kinds, never the values', (t) => {
  const fx = fixture(t);
  const out = ok(run(fx));
  const tsv = fs.readFileSync(path.join(path.dirname(out.match(/^отчёт: (.+)$/m)[1]), 'secrets.tsv'), 'utf8');
  assert.match(tsv, /^github-token\t1\tjournals\/proj-b\/s2\.jsonl$/m);
  assert.match(tsv, /^assignment\t1\thub\/projects\/p1\/memory\/task-1\/\.env\.example$/m);
  assert.match(out, /^секреты: файлов 2/m);
  const everything = [out, reportOf(out), tsv].join('\n');
  assert.ok(!everything.includes(FAKE_GH), 'token value leaked');
  assert.ok(!everything.includes('fake-eval-token'), 'assignment value leaked');
  assert.doesNotMatch(tsv, /code-notes\.md/);
});

test('verify: never rounds a partial match up to 100%', (t) => {
  const fx = fixture(t);
  for (let i = 0; i < 2000; i++) write(path.join(fx.journals, 'many', `${i}.jsonl`), `{"n":${i}}\n`);
  ok(run(fx));
  fs.writeFileSync(path.join(fx.dest, 'journals', 'many', '7.jsonl'), 'broken\n');
  const bad = verify(fx);
  assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^журналы: манифест сходится 2002 из 2003 \(99\.9%\)/m);
});

test('snapshot: an unreadable source folder is an error that names it, not a silent skip', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root reads everything');
  const fx = fixture(t);
  const locked = path.join(fx.journals, 'proj-a', 's1');
  fs.chmodSync(locked, 0o000);
  let r;
  try { r = run(fx); } finally { fs.chmodSync(locked, 0o755); } // before the fixture's own cleanup
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}! proj-a\/s1: /m);
  assert.match(r.stdout, /^хаб: файлов 21/m);
});

test('verify: a bundle damaged inside (git bundle verify still passes) fails by its manifest checksum', (t) => {
  const fx = fixture(t);
  ok(run(fx));
  const b = path.join(fx.dest, 'bundles', 'p2--site.bundle');
  assert.match(fs.readFileSync(path.join(fx.dest, 'bundles', 'MANIFEST.sha256'), 'utf8'), /^[0-9a-f]{64} {2}p2--site\.bundle$/m);
  const buf = fs.readFileSync(b);
  buf[buf.length - 30] ^= 0xff;
  fs.writeFileSync(b, buf);
  const bad = verify(fx);
  assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^ {2}! p2--site: /m);
});

test('snapshot: a branch whose upstream is gone is reported as local-only', (t) => {
  const fx = fixture(t);
  const repo = path.join(fx.hub, 'projects', 'p1', 'repo');
  git(repo, 'branch', 'merged-away');
  git(repo, 'remote', 'add', 'origin', path.join(fx.root, 'no-such-remote.git'));
  git(repo, 'config', 'branch.merged-away.remote', 'origin');
  git(repo, 'config', 'branch.merged-away.merge', 'refs/heads/merged-away');
  const rep = reportOf(ok(run(fx)));
  assert.match(rep, /ветки без upstream: [^\n]*merged-away \(upstream удалён\)/);
});

test('snapshot: an empty journals folder is a valid (empty) area', (t) => {
  const fx = fixture(t);
  fs.rmSync(fx.journals, { recursive: true });
  fs.mkdirSync(fx.journals);
  assert.match(ok(run(fx)), /^журналы: 0 новых, 0 изменённых \(файлов 0/m);
  assert.match(ok(verify(fx)), /^журналы: манифест сходится 0 из 0 \(100%\)/m);
});

test('snapshot: a file name the manifest cannot hold (newline) is an error; the rest is copied and verifies', (t) => {
  const fx = fixture(t);
  write(path.join(fx.journals, 'proj-a', 'bad\nname.jsonl'), '{}\n');
  const r = run(fx);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}! 'proj-a\/bad\\nname\.jsonl': /m);
  assert.match(r.stdout, /^журналы: файлов 3, новых 3/m);
  assert.match(ok(verify(fx)), /манифест сходится 3 из 3 \(100%\)/);
});

test('secret scan: plain passwords and keys are found, one per assignment', (t) => {
  const fx = fixture(t);
  write(path.join(fx.hub, 'projects', 'p2', 'memory', 'passwords.env'), PASSWORDS + '\n');
  const out = ok(run(fx));
  const tsv = fs.readFileSync(path.join(path.dirname(out.match(/^отчёт: (.+)$/m)[1]), 'secrets.tsv'), 'utf8');
  assert.match(tsv, /^assignment\t6\thub\/projects\/p2\/memory\/passwords\.env$/m);
  assert.ok(!out.includes('hunter2') && !tsv.includes('hunter2'), 'password value leaked');
});

test('secret scan: a run interrupted after the copy still scans what it copied, on the next run', (t) => {
  const fx = fixture(t);
  ok(run(fx));
  write(path.join(fx.hub, 'projects', 'p1', 'memory', 'leak.md'), 'API_TOKEN=Abcd1234Efgh5678IJKL\n');
  assert.notStrictEqual(runInterrupted(fx).status, 0);
  const out = ok(run(fx));
  const tsv = fs.readFileSync(path.join(path.dirname(out.match(/^отчёт: (.+)$/m)[1]), 'secrets.tsv'), 'utf8');
  assert.match(tsv, /^assignment\t1\thub\/projects\/p1\/memory\/leak\.md$/m);
});

test('secret scan: new rules rescan the whole copy, not only new files', (t) => {
  const fx = fixture(t);
  ok(run(fx));
  const statePath = path.join(fx.dest, '.state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.secret_rules = 'older-rules';
  state.secrets = {};
  fs.writeFileSync(statePath, JSON.stringify(state));
  const out = ok(run(fx));
  assert.match(out, /^секреты: файлов 2/m);
});

test('snapshot: files under an unreadable folder are not counted as gone, the journals root included', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root reads everything');
  const fx = fixture(t);
  ok(run(fx));
  for (const dir of [path.join(fx.journals, 'proj-a', 's1'), fx.journals]) {
    fs.chmodSync(dir, 0o000);
    let r;
    try { r = run(fx); } finally { fs.chmodSync(dir, 0o755); }
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^журналы: 0 новых, 0 изменённых \(файлов 3, пропало в источнике 0\)/m);
  }
});

test('snapshot: a bundle whose repo is gone keeps its old checksum — later damage is not blessed', (t) => {
  const fx = fixture(t);
  ok(run(fx));
  fs.rmSync(path.join(fx.hub, 'projects', 'p2', 'site'), { recursive: true });
  const b = path.join(fx.dest, 'bundles', 'p2--site.bundle');
  const buf = fs.readFileSync(b);
  buf[buf.length - 30] ^= 0xff;
  fs.writeFileSync(b, buf);
  ok(run(fx));
  const bad = verify(fx);
  assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^ {2}! p2--site: бандл не совпадает с манифестом/m);
});

test('snapshot: a broken or lost bundle manifest does not bless a damaged old bundle either', (t) => {
  for (const spoil of [(m) => fs.writeFileSync(m, fs.readFileSync(m, 'utf8').replace(/ {2}/g, '\t')), (m) => fs.rmSync(m)]) {
    const fx = fixture(t);
    ok(run(fx));
    fs.rmSync(path.join(fx.hub, 'projects', 'p2', 'site'), { recursive: true });
    const b = path.join(fx.dest, 'bundles', 'p2--site.bundle');
    const buf = fs.readFileSync(b);
    buf[buf.length - 30] ^= 0xff;
    fs.writeFileSync(b, buf);
    spoil(path.join(fx.dest, 'bundles', 'MANIFEST.sha256'));
    ok(run(fx));
    const bad = verify(fx);
    assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /^ {2}! p2--site: бандл не совпадает с манифестом/m);
  }
});
