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

const ALL = ['auto-memory', 'bash-cwd', 'checks-json', 'dispatch-profile', 'dispatch-rules', 'journal-retention', 'plugin-version', 'status-line'];

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

  // Project files come from the templates, the repo's local settings point auto-memory into the hub project.
  for (const f of ['dispatch-profile.md', 'dispatch-rules.json', 'checks.json']) assert.ok(fs.existsSync(path.join(fx.proj, f)), f);
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

test('a longer retention or an own status line is the user\'s: retention is never lowered', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.claude, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 1000, desktopSessionCleanupPeriodDays: 400 }));
  assert.ok(!missing(checkJson(fx)).includes('journal-retention'));
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
