#!/usr/bin/env node
// Install the hub as the Claude Code plugin `hub` from this folder (a local marketplace, read in place: edits
// apply from the next session). Writes ~/.claude/settings.json (backup first): the marketplace `hub` and the
// enabled plugin `hub@hub`; removes what the old install left — the user-level guard hook (now the plugin's
// PreToolUse), junctions of hub skills in ~/.claude/skills and copies of hub agents in ~/.claude/agents
// (moved to a backup, never deleted). Idempotent. usage: node install.cjs [--dry-run]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dry = process.argv.includes('--dry-run');
const hub = __dirname.replace(/\\/g, '/');
const home = path.join(os.homedir(), '.claude');
const file = path.join(home, 'settings.json');
const stamp = new Date().toISOString().slice(0, 10);
const say = (s) => console.log(s);

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
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  say('settings: marketplace hub, plugin hub@hub enabled, old guard hook removed');
}

// Leftovers of the junction install: links to <hub>/.claude/skills/* (or later layouts), copies of hub agents.
const plugin = path.join(hub, 'plugin');
const skillsDir = path.join(home, 'skills');
for (const name of fs.existsSync(path.join(plugin, 'skills')) ? fs.readdirSync(path.join(plugin, 'skills')) : []) {
  const p = path.join(skillsDir, name);
  let st; try { st = fs.lstatSync(p); } catch { continue; }
  let target = null;
  try { target = fs.readlinkSync(p); } catch { /* not a link */ }
  const ours = target && path.resolve(target).replace(/\\/g, '/').toLowerCase().startsWith(hub.toLowerCase() + '/');
  if (!st.isSymbolicLink() || !ours) { say(`kept     skills/${name}: not a link into this hub — check it by hand`); continue; }
  if (!dry) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } } // the link itself, never its target
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
say('Done. Start a NEW Claude Code session: skills /hub:*, agents hub:*, hooks of the plugin load at session start.');
