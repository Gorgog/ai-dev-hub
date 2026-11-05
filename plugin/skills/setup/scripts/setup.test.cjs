// node --test setup.test.cjs — local settings of the hub: what is missing, and /hub:setup applying each one.
// A synthetic hub (git, main), a synthetic ~/.claude (CLAUDE_CONFIG_DIR) and a fake `claude` CLI on PATH: the real
// settings of the machine are never read or written.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'setup.cjs');
const MODULE = path.join(__dirname, '..', '..', '..', 'hooks', 'sessionstart.d', '20-setup.cjs');
const TEMPLATES = path.join(__dirname, '..', '..', '..', '..', 'templates', 'project');

// git without the GIT_* of a calling hook (a pre-commit run would otherwise write into the hub's own repository).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  git(dir, 'add', 'a.txt');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a');
  return git(dir, 'rev-parse', 'HEAD');
};

// hub (git on main) + templates + projects/demo/repo (git) + empty claude dir + fake claude CLI.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-setup-'));
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(hub, 'templates'), { recursive: true });
  fs.cpSync(TEMPLATES, path.join(hub, 'templates', 'project'), { recursive: true });
  const sha = gitRepo(hub);
  const proj = path.join(hub, 'projects', 'demo');
  fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });
  const repo = path.join(proj, 'repo');
  gitRepo(repo);
  const claude = path.join(root, 'claude');
  fs.mkdirSync(claude);
  // Fake CLI: logs its args; `plugin update hub@hub` records the hub's main as installed (as the real update does).
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    `echo "$*" >> "${path.join(root, 'cli.log')}"`,
    'if [ "$1 $2 $3" = "plugin update hub@hub" ]; then',
    `  mkdir -p "$CLAUDE_CONFIG_DIR/plugins"`,
    `  printf '{"version":2,"plugins":{"hub@hub":[{"scope":"user","gitCommitSha":"${sha}"}]}}' > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"`,
    'fi',
    'exit 0', ''].join('\n'), { mode: 0o755 });
  const env = { ...cleanEnv(), CLAUDE_CONFIG_DIR: claude, AI_DEV_HUB: hub, PATH: `${bin}:${process.env.PATH}` };
  return { root, hub, sha, proj, repo, claude, env };
}

const run = (fx, args, cwd = fx.repo) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: fx.env, encoding: 'utf8' });
const checkJson = (fx, cwd) => { const r = run(fx, ['check', '--json'], cwd); assert.strictEqual(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const missing = (list) => list.filter((c) => c.ok === false).map((c) => c.id).sort();
const settings = (fx) => JSON.parse(fs.readFileSync(path.join(fx.claude, 'settings.json'), 'utf8'));

const ALL = ['auto-memory', 'bash-cwd', 'journal-retention', 'plugin-version', 'status-line'];
// A project that uses the dispatcher (its board memory/dispatch.md) also needs these — written by hand, never a copy.
const HAND = ['checks-json', 'dispatch-profile', 'dispatch-rules'];

test('check: a bare machine misses every setting, and the text says «не хватает N»', () => {
  const fx = fixture();
  assert.deepStrictEqual(missing(checkJson(fx)), ALL);
  const r = run(fx, ['check']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`не хватает ${ALL.length} настроек`));
  assert.match(r.stdout, /\/hub:setup/);
});

test('apply: each setting one call, then check says 0; the plugin is updated through the claude CLI', () => {
  const fx = fixture();
  for (const id of ALL) {
    const r = run(fx, ['apply', id]);
    assert.strictEqual(r.status, 0, `${id}: ${r.stdout}${r.stderr}`);
  }
  assert.deepStrictEqual(missing(checkJson(fx)), []);
  assert.match(run(fx, ['check']).stdout, /не хватает 0 настроек/);

  const s = settings(fx);
  assert.strictEqual(s.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, '1');
  assert.strictEqual(s.cleanupPeriodDays, 365);
  assert.strictEqual(s.desktopSessionCleanupPeriodDays, 365);
  assert.strictEqual(s.statusLine.type, 'command');
  assert.match(s.statusLine.command, /statusline\.cjs/);
  assert.ok(s.statusLine.command.includes(path.join(fx.hub, 'plugin', 'skills', 'setup', 'scripts', 'statusline.cjs')),
    'the status line runs from the hub main copy, not from a worktree or cache');
  const cli = fs.readFileSync(path.join(fx.root, 'cli.log'), 'utf8');
  assert.match(cli, /plugin marketplace update hub/);
  assert.match(cli, /plugin update hub@hub/);

  // The repo's local settings point auto-memory into the hub project; no project file appears by itself.
  for (const f of ['dispatch-profile.md', 'dispatch-rules.json', 'checks.json']) assert.ok(!fs.existsSync(path.join(fx.proj, f)), f);
  const local = JSON.parse(fs.readFileSync(path.join(fx.repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.strictEqual(local.autoMemoryDirectory, path.join(fx.proj, 'memory', 'auto') + '/');
  // …and the client repository stays clean: the local settings file is excluded locally, never committed.
  assert.strictEqual(git(fx.repo, 'status', '--porcelain'), '');
});

test('apply keeps the rest of settings.json, backs it up once, and a second apply changes nothing', () => {
  const fx = fixture();
  const file = path.join(fx.claude, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', env: { FOO: 'bar' }, cleanupPeriodDays: 30 }, null, 2));
  assert.strictEqual(run(fx, ['apply', 'bash-cwd']).status, 0);
  assert.strictEqual(run(fx, ['apply', 'journal-retention']).status, 0);
  const s = settings(fx);
  assert.strictEqual(s.theme, 'dark');
  assert.deepStrictEqual(s.env, { FOO: 'bar', CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' });
  assert.strictEqual(s.cleanupPeriodDays, 365);
  const backups = () => fs.readdirSync(fx.claude).filter((f) => f.startsWith('settings.json.bak-'));
  assert.strictEqual(backups().length, 2, 'one backup per change');
  const again = run(fx, ['apply', 'bash-cwd']);
  assert.strictEqual(again.status, 0);
  assert.match(again.stdout, /уже стоит/);
  assert.strictEqual(backups().length, 2, 'an unchanged setting is not backed up again');
});

test('a longer retention or an own status line is the user\'s: never lowered, never replaced', () => {
  const fx = fixture();
  const own = { type: 'command', command: '~/my-line.sh' };
  fs.writeFileSync(path.join(fx.claude, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 1000, desktopSessionCleanupPeriodDays: 400, statusLine: own }));
  const m = missing(checkJson(fx));
  assert.ok(!m.includes('journal-retention'));
  assert.ok(!m.includes('status-line'), 'an own status line is a choice, not a missing setting');
  assert.strictEqual(run(fx, ['apply', 'status-line']).status, 0);
  assert.strictEqual(run(fx, ['apply', 'journal-retention']).status, 0);
  assert.deepStrictEqual(settings(fx).statusLine, own);
  assert.strictEqual(settings(fx).cleanupPeriodDays, 1000);
});

test('a symlinked settings.json stays a link: the change lands in its target', () => {
  const fx = fixture();
  const dots = path.join(fx.root, 'dots');
  fs.mkdirSync(dots);
  fs.writeFileSync(path.join(dots, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  fs.symlinkSync(path.join(dots, 'settings.json'), path.join(fx.claude, 'settings.json'));
  assert.strictEqual(run(fx, ['apply', 'bash-cwd']).status, 0);
  assert.ok(fs.lstatSync(path.join(fx.claude, 'settings.json')).isSymbolicLink());
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dots, 'settings.json'), 'utf8')).env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, '1');
});

test('a dangling symlink stays a link (its target is created); a wrapper around our status line is the user\'s', () => {
  const fx = fixture();
  const dots = path.join(fx.root, 'dots');
  fs.mkdirSync(dots);
  fs.symlinkSync(path.join(dots, 'settings.json'), path.join(fx.claude, 'settings.json'));
  assert.strictEqual(run(fx, ['apply', 'journal-retention']).status, 0);
  assert.ok(fs.lstatSync(path.join(fx.claude, 'settings.json')).isSymbolicLink(), 'the link survives');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dots, 'settings.json'), 'utf8')).cleanupPeriodDays, 365);

  const wrap = { type: 'command', command: `bash -c "node ${fx.hub}/plugin/skills/setup/scripts/statusline.cjs | tee /tmp/l"` };
  fs.writeFileSync(path.join(dots, 'settings.json'), JSON.stringify({ statusLine: wrap }));
  assert.strictEqual(checkJson(fx).find((c) => c.id === 'status-line').ok, true);
  assert.strictEqual(run(fx, ['apply', 'status-line']).status, 0);
  assert.deepStrictEqual(settings(fx).statusLine, wrap);
});

test('a chain of links dangling at the second hop: no link becomes a file; our old line with a space is updated', () => {
  const fx = fixture();
  const dots = path.join(fx.root, 'dots');
  fs.mkdirSync(path.join(dots, 'real'), { recursive: true });
  fs.symlinkSync('real/target.json', path.join(dots, 'mid.json'));
  fs.symlinkSync('../dots/mid.json', path.join(fx.claude, 'settings.json'));
  assert.strictEqual(run(fx, ['apply', 'journal-retention']).status, 0);
  assert.ok(fs.lstatSync(path.join(fx.claude, 'settings.json')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(dots, 'mid.json')).isSymbolicLink(), 'the middle link survives');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dots, 'real', 'target.json'), 'utf8')).cleanupPeriodDays, 365);

  const old = 'node "/old place/John Doe/hub/plugin/skills/setup/scripts/statusline.cjs"';
  fs.writeFileSync(path.join(dots, 'real', 'target.json'), JSON.stringify({ statusLine: { type: 'command', command: old } }));
  assert.strictEqual(checkJson(fx).find((c) => c.id === 'status-line').ok, false, 'our line at an old path is ours to update');
  assert.strictEqual(run(fx, ['apply', 'status-line']).status, 0);
  assert.notStrictEqual(settings(fx).statusLine.command, old);
});

test('the file mode of settings.json is kept, the backup too (keys in env stay private)', () => {
  const fx = fixture();
  const file = path.join(fx.claude, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ env: { SOME_KEY: 'x' } }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  assert.strictEqual(run(fx, ['apply', 'bash-cwd']).status, 0);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const bak = fs.readdirSync(fx.claude).find((f) => f.startsWith('settings.json.bak-'));
  assert.strictEqual(fs.statSync(path.join(fx.claude, bak)).mode & 0o777, 0o600);
});

test('project files of the dispatcher: missing only where the project uses it; written by hand, a template copy is not ready', () => {
  const fx = fixture();
  assert.deepStrictEqual(checkJson(fx).filter((c) => HAND.includes(c.id)).map((c) => c.ok), [null, null, null], 'no board — not counted');
  fs.writeFileSync(path.join(fx.proj, 'memory', 'dispatch.md'), '# доска\n');
  assert.deepStrictEqual(missing(checkJson(fx)), [...ALL, ...HAND].sort());
  for (const id of HAND) {
    const r = run(fx, ['apply', id]);
    assert.strictEqual(r.status, 4, `${id}: apply never writes a project file — ${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /templates\/project/);
  }
  assert.ok(!fs.existsSync(path.join(fx.proj, 'dispatch-rules.json')), 'no lock rules appear by themselves');
  const tmpl = path.join(fx.hub, 'templates', 'project');
  fs.copyFileSync(path.join(tmpl, 'dispatch-rules.example.json'), path.join(fx.proj, 'dispatch-rules.json'));
  assert.strictEqual(checkJson(fx).find((c) => c.id === 'dispatch-rules').ok, false, 'an untouched template copy is not ready');
  fs.writeFileSync(path.join(fx.proj, 'dispatch-rules.json'), JSON.stringify({ heavy: [], medium: [] }));
  fs.writeFileSync(path.join(fx.proj, 'dispatch-profile.md'), '# Профиль\n');
  fs.writeFileSync(path.join(fx.proj, 'checks.json'), '{"steps": []}');
  assert.deepStrictEqual(missing(checkJson(fx)).filter((id) => HAND.includes(id)), []);
});

test('a broken settings.json is reported and never overwritten', () => {
  const fx = fixture();
  const file = path.join(fx.claude, 'settings.json');
  fs.writeFileSync(file, '{ broken');
  const r = run(fx, ['apply', 'bash-cwd']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /settings\.json/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('outside a hub project only the machine settings count; an unknown id is refused', () => {
  const fx = fixture();
  const ids = checkJson(fx, fx.root).map((c) => c.id).sort();
  assert.deepStrictEqual(ids, ['allowlist', 'bash-cwd', 'journal-retention', 'plugin-version', 'status-line']);
  const r = run(fx, ['apply', 'no-such']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /no-such/);
});

test('plugin-version: the installed hub@hub must be the hub main, an older one is missing', () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.claude, 'plugins'));
  const write = (sha) => fs.writeFileSync(path.join(fx.claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'hub@hub': [{ scope: 'user', gitCommitSha: sha }] } }));
  write('0000000000000000000000000000000000000000');
  const c = checkJson(fx).find((x) => x.id === 'plugin-version');
  assert.strictEqual(c.ok, false);
  assert.match(c.have, /0000000/);
  assert.match(c.want, new RegExp(fx.sha.slice(0, 7)));
  write(fx.sha);
  assert.strictEqual(checkJson(fx).find((x) => x.id === 'plugin-version').ok, true);
});

test('allowlist: approved entries only, written into permissions.allow; an empty list is nothing to do', () => {
  const fx = fixture();
  assert.strictEqual(checkJson(fx).find((c) => c.id === 'allowlist').ok, true, 'the shipped list is empty');
  const list = path.join(fx.root, 'allow.json');
  fs.writeFileSync(list, JSON.stringify({ allow: [{ rule: 'Bash(git status:*)', why: 'чтение' }] }));
  fx.env.HUB_SETUP_ALLOWLIST = list;
  assert.strictEqual(checkJson(fx).find((c) => c.id === 'allowlist').ok, false);
  assert.strictEqual(run(fx, ['apply', 'allowlist']).status, 0);
  assert.deepStrictEqual(settings(fx).permissions.allow, ['Bash(git status:*)']);
  assert.strictEqual(checkJson(fx).find((c) => c.id === 'allowlist').ok, true);
});

test('auto-memory in a worktree: the worktree root gets the local settings, excluded in the common git dir', () => {
  const fx = fixture();
  const wt = path.join(fx.proj, 'worktrees', 'K-1');
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'K-1', wt);
  const sub = path.join(wt, 'src');
  fs.mkdirSync(sub);
  assert.strictEqual(run(fx, ['apply', 'auto-memory'], sub).status, 0);
  assert.ok(fs.existsSync(path.join(wt, '.claude', 'settings.local.json')), 'the file is at the worktree root, not in src/');
  assert.strictEqual(git(wt, 'status', '--porcelain'), '', 'nothing new to commit (src/ is empty)');
  assert.strictEqual(checkJson(fx, sub).find((c) => c.id === 'auto-memory').ok, true);
  // A fresh worktree is not counted as missing: a task session cannot get the user's yes, wt-new.sh is the place.
  const wt2 = path.join(fx.proj, 'worktrees', 'K-2');
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'K-2', wt2);
  const c = checkJson(fx, wt2).find((x) => x.id === 'auto-memory');
  assert.strictEqual(c.ok, null);
  assert.match(c.have, /worktree/);
  assert.doesNotMatch(c.have, /ставит wt-new/, 'no mechanism is named that does not exist');
  const r = run(fx, ['apply', 'dispatch-rules']);
  assert.strictEqual((r.stdout.match(/не нужен/g) || []).length, 1, r.stdout);
});

test('module: SessionStart says «не хватает N» with /hub:setup, silent when nothing is missing or on compact', async () => {
  const fx = fixture();
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: fx.claude, AI_DEV_HUB: fx.hub, PATH: fx.env.PATH });
  try {
    assert.ok(fs.existsSync(MODULE), `${MODULE} — модуль SessionStart`);
    delete require.cache[require.resolve(MODULE)];
    const mod = require(MODULE);
    assert.strictEqual(mod.id, 'setup');
    const ctx = { hub: fx.hub, project: { dir: fx.proj, name: 'demo' } };
    const res = await mod.run({ cwd: fx.repo, source: 'startup' }, ctx);
    assert.strictEqual(res.items.length, 1);
    assert.match(res.items[0].text, new RegExp(`не хватает ${ALL.length} настроек`));
    assert.match(res.items[0].text, /\/hub:setup/);
    assert.strictEqual(await mod.run({ cwd: fx.repo, source: 'compact' }, ctx), null);
    for (const id of ALL) assert.strictEqual(run(fx, ['apply', id]).status, 0, id);
    assert.strictEqual(await mod.run({ cwd: fx.repo, source: 'startup' }, ctx), null);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
