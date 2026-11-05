#!/usr/bin/env node
// Install the hub as the Claude Code plugin `hub` from this folder (a local marketplace). The hooks run straight from
// this folder's working tree (CLAUDE_PLUGIN_ROOT is the marketplace folder, probe P17): a commit here is live in every
// session at once, and hooks.json is read at session start. This script runs `claude plugin marketplace update hub`
// and `claude plugin update hub@hub` when the CLI is there. Writes ~/.claude/settings.json (backup first): the
// marketplace `hub` and the enabled plugin `hub@hub`; removes what the old install left — the user-level guard hook
// (now the plugin's PreToolUse), links to hub skills in ~/.claude/skills and copies of hub agents in ~/.claude/agents
// (moved to a backup, never deleted). Checks node ≥ 22 (the hook spine needs it). Idempotent. Ends with what
// /hub:setup would still set on this machine (plugin/skills/setup/scripts/setup.cjs check).
// usage: node install.cjs [--dry-run]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dry = process.argv.includes('--dry-run');
const hub = __dirname;
const home = path.join(os.homedir(), '.claude');
const file = path.join(home, 'settings.json');
const stamp = new Date().toISOString().slice(0, 10);
const say = (s) => console.log(s);

// The hook spine (plugin/hooks/run.cjs) runs on node ≥ 22 with node:sqlite; older node — say it, install anyway.
const major = Number(process.versions.node.split('.')[0]);
let sqlite = true;
try { require('node:sqlite'); } catch { sqlite = false; }
if (major < 22 || !sqlite) say(`node:    ${process.versions.node}${sqlite ? '' : ' без node:sqlite'} — хукам хаба нужен node ≥ 22; обнови node`);

let settings = {};
if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'));
const before = JSON.stringify(settings);

settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
const cur = settings.extraKnownMarketplaces.hub;
const same = cur && cur.source && cur.source.source === 'directory' && path.resolve(cur.source.path || '') === path.resolve(hub);
if (!same) settings.extraKnownMarketplaces.hub = { source: { source: 'directory', path: hub } };
settings.enabledPlugins = settings.enabledPlugins || {};
settings.enabledPlugins['hub@hub'] = true;

const isOldGuard = (h) => h && h.type === 'command' && /dispatch[\\/]+scripts[\\/]+guard\.cjs/.test(h.command || '');
if (settings.hooks && Array.isArray(settings.hooks.PreToolUse)) {
  settings.hooks.PreToolUse = settings.hooks.PreToolUse
    .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !isOldGuard(h)) }))
    .filter((e) => e.hooks.length);
  if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

if (JSON.stringify(settings) === before) say('settings: already installed');
else if (dry) say(JSON.stringify({ extraKnownMarketplaces: settings.extraKnownMarketplaces, enabledPlugins: settings.enabledPlugins, hooks: settings.hooks }, null, 2));
else {
  if (fs.existsSync(file)) { const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`; fs.copyFileSync(file, bak); say(`backup:   ${bak}`); }
  fs.mkdirSync(home, { recursive: true }); // a new machine may not have ~/.claude yet
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  say('settings: marketplace hub, plugin hub@hub enabled, old guard hook removed');
}

// Leftovers of the old install: links to <hub>/.claude/skills/* (or later layouts), copies of hub agents.
const plugin = path.join(hub, 'plugin');
const skillsDir = path.join(home, 'skills');
for (const name of fs.existsSync(path.join(plugin, 'skills')) ? fs.readdirSync(path.join(plugin, 'skills')) : []) {
  const p = path.join(skillsDir, name);
  let st; try { st = fs.lstatSync(p); } catch { continue; }
  let target = null;
  try { target = fs.readlinkSync(p); } catch { /* not a link */ }
  const ours = target && path.resolve(skillsDir, target).startsWith(hub + '/');
  if (!st.isSymbolicLink() || !ours) { say(`kept     skills/${name}: not a link into this hub — check it by hand`); continue; }
  if (!dry) fs.unlinkSync(p); // the link itself, never its target
  say(`unlinked skills/${name} (the plugin provides /hub:${name})`);
}
const agentsDir = path.join(home, 'agents');
for (const name of fs.existsSync(path.join(plugin, 'agents')) ? fs.readdirSync(path.join(plugin, 'agents')) : []) {
  const p = path.join(agentsDir, name);
  if (!fs.existsSync(p)) continue;
  // Only an old copy of the hub agent: the same `name:` in its frontmatter.
  const nameLine = (f) => (fs.readFileSync(f, 'utf8').match(/^name:\s*(.+)$/m) || [])[1];
  if (nameLine(p) !== nameLine(path.join(plugin, 'agents', name))) { say(`kept     agents/${name}: not a copy of the hub agent`); continue; }
  const bakDir = path.join(home, `agents-backup-${stamp}`);
  let dest = path.join(bakDir, name);
  if (fs.existsSync(dest)) dest = path.join(bakDir, `${Date.now()}-${name}`);
  if (!dry) { fs.mkdirSync(bakDir, { recursive: true }); fs.renameSync(p, dest); }
  say(`moved    agents/${name} -> ${bakDir} (the plugin provides hub:${name.replace(/\.md$/, '')})`);
}
// Refresh the cached copy of the plugin to the current commit (the CLI may be missing or not signed in — then say how).
// On a new machine the marketplace is only declared in settings, and the CLI answers "Marketplace 'hub' not found"
// until it is added: then add it and install the plugin instead of updating.
if (!dry) {
  const { spawnSync } = require('child_process');
  const cli = (args) => spawnSync('claude', args, { encoding: 'utf8' });
  const text = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim();
  let m = cli(['plugin', 'marketplace', 'update', 'hub']);
  let next = ['plugin', 'update', 'hub@hub'];
  if (m.status !== 0 && /not found/i.test(text(m))) {
    m = cli(['plugin', 'marketplace', 'add', hub]);
    next = ['plugin', 'install', 'hub@hub'];
  }
  const u = m.status === 0 ? cli(next) : m;
  const out = text(u).split('\n').pop();
  say(u.status === 0 ? `plugin:  ${out}` : 'plugin:  claude CLI недоступен — обнови вручную: claude plugin marketplace update hub && claude plugin update hub@hub');
}
// Local settings of the machine the installer does not set itself (env of Bash, journal retention, status line,
// allowlist): /hub:setup sets each one with a confirmation; here — only what is missing.
try {
  const setup = require('./plugin/skills/setup/scripts/setup.cjs');
  const list = setup.check({ cwd: hub, hub });
  const lack = setup.missingOf(list).map((c) => c.id);
  say(`setup:   ${setup.summary(list)}${lack.length ? ` (${lack.join(', ')}) — в новой сессии: /hub:setup` : ''}`);
} catch (e) { say(`setup:   проверка не прошла (${String(e.message).split('\n')[0]}) — в новой сессии: /hub:setup`); }
say('Done. Start a NEW Claude Code session: skills /hub:*, agents hub:*, hooks of the plugin load at session start.');
say(`Switch the hub off: the file ${path.join(hub, '.hub-off')} — live sessions too, no restart (remove it to switch back on); HUB_OFF=1 — for a session started with it.`);
