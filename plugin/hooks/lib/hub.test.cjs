// node --test plugin/hooks/lib/hub.test.cjs
// Where the hub is and which project a cwd belongs to: the hub's own root is the project of the hub itself (its
// canary, its rules), the settings come from CLAUDE_CONFIG_DIR when it is set.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, 'hub.cjs');
const { findProject, worktreeOf } = require(LIB);

const made = [];
const mkdtemp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function hub({ self = true } = {}) {
  const h = mkdtemp('hub-lib-');
  fs.mkdirSync(path.join(h, 'projects', 'demo', 'worktrees', 'K-1'), { recursive: true });
  if (self) fs.mkdirSync(path.join(h, 'projects', 'ai-dev-hub', 'worktrees', 'HUBV2-1'), { recursive: true });
  fs.mkdirSync(path.join(h, 'plugin', 'hooks'), { recursive: true });
  return h;
}

test('a project of the hub stays itself; its worktree is named', () => {
  const h = hub();
  assert.deepStrictEqual(findProject(path.join(h, 'projects', 'demo', 'worktrees', 'K-1'), h), { dir: path.join(h, 'projects', 'demo'), name: 'demo' });
  const p = findProject(path.join(h, 'projects', 'ai-dev-hub', 'worktrees', 'HUBV2-1'), h);
  assert.strictEqual(p.name, 'ai-dev-hub');
  assert.strictEqual(worktreeOf(path.join(h, 'projects', 'ai-dev-hub', 'worktrees', 'HUBV2-1'), p), 'HUBV2-1');
});

test('the hub root and its folders outside projects/ are the project ai-dev-hub (its canary works there)', () => {
  const h = hub();
  const want = { dir: path.join(h, 'projects', 'ai-dev-hub'), name: 'ai-dev-hub' };
  assert.deepStrictEqual(findProject(h, h), want);
  assert.deepStrictEqual(findProject(path.join(h, 'plugin', 'hooks'), h), want);
  assert.strictEqual(worktreeOf(h, want), null);
  assert.strictEqual(worktreeOf(path.join(h, 'plugin', 'hooks'), want), null);
});

test('a hub without projects/ai-dev-hub: the root is no project, as before', () => {
  const h = hub({ self: false });
  assert.strictEqual(findProject(h, h), null);
  assert.strictEqual(findProject(path.join(h, 'plugin'), h), null);
});

test('outside the hub nothing changes: a sibling folder with a similar name is not the hub', () => {
  const h = hub();
  const sib = `${h}-other`;
  fs.mkdirSync(sib, { recursive: true });
  made.push(sib);
  assert.strictEqual(findProject(sib, h), null);
  assert.strictEqual(findProject(path.dirname(h), h), null);
  assert.strictEqual(findProject(path.join(h, 'projects'), h), null);
});

// hubRoot() runs at load: a child process with its own environment.
function rootIn(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AI_DEV_HUB|CLAUDE_CONFIG_DIR|HOME)$/.test(k)));
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(LIB)}).HUB_ROOT)`], { env: { ...clean, ...env }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}
const settings = (dir, hubPath) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { hub: { source: { source: 'directory', path: hubPath } } } }));
};

test('hubRoot reads the settings of CLAUDE_CONFIG_DIR when it is set, of ~/.claude otherwise', () => {
  const h1 = hub(), h2 = hub();
  const home = mkdtemp('hub-home-');
  settings(path.join(home, '.claude'), h1);
  const conf = mkdtemp('hub-conf-');
  settings(conf, h2);
  assert.strictEqual(rootIn({ HOME: home }), h1);
  assert.strictEqual(rootIn({ HOME: home, CLAUDE_CONFIG_DIR: conf }), h2);
  assert.strictEqual(rootIn({ HOME: home, CLAUDE_CONFIG_DIR: conf, AI_DEV_HUB: h1 }), h1, 'AI_DEV_HUB still wins');
});
