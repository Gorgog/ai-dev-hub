#!/usr/bin/env node
// Adds (or updates) the dispatcher's guard.cjs as a PreToolUse hook in ~/.claude/settings.json.
// User-level on purpose: project settings of a worktree belong to the work repo, the hub's settings do not apply
// there. The guard itself does nothing outside <hub>/projects/*/worktrees/*.
// Idempotent; backs up settings.json to settings.json.bak-<timestamp> before the first change.
// usage: node install-guard.cjs [--dry-run]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dry = process.argv.includes('--dry-run');
const guard = path.join(__dirname, 'guard.cjs').replace(/\\/g, '/');
const command = `node "${guard}"`;
const matcher = 'Bash|PowerShell|mcp__Claude_Browser__.*|mcp__claude-in-chrome__.*';
const file = path.join(os.homedir(), '.claude', 'settings.json');

let settings = {};
if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'));
settings.hooks = settings.hooks || {};
const pre = (settings.hooks.PreToolUse = settings.hooks.PreToolUse || []);

const isOurs = (h) => h && h.type === 'command' && /dispatch[\\/]+scripts[\\/]+guard\.cjs/.test(h.command || '');
let entry = pre.find((e) => (e.hooks || []).some(isOurs));
const before = JSON.stringify(settings);
if (entry) {
  entry.matcher = matcher;
  entry.hooks = entry.hooks.map((h) => (isOurs(h) ? { type: 'command', command } : h));
} else {
  pre.push({ matcher, hooks: [{ type: 'command', command }] });
}
if (JSON.stringify(settings) === before) { console.log('guard hook already installed:', command); process.exit(0); }
if (dry) { console.log(JSON.stringify(settings.hooks, null, 2)); process.exit(0); }

if (fs.existsSync(file)) {
  const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, bak);
  console.log('backup:', bak);
}
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log('guard hook installed:', command);
