#!/usr/bin/env node
// PreToolUse of the hub plugin, one node process per tool call:
//   1) the dispatcher's resource lock (skills/dispatch/scripts/guard.cjs, worktrees only) — a block is exit 2;
//   2) rules-guard: rules from memory (base-rules.json + projects/<name>/rules.json) — log / ask / deny.
// Any internal error passes the call through: the hook must never break a session.
'use strict';
const fs = require('fs');
const path = require('path');
let ev = {};
try { ev = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

try {
  const { decide } = require('../skills/dispatch/scripts/guard.cjs');
  const lock = decide(ev);
  if (lock) { process.stderr.write(lock.reason); process.exit(2); }
} catch { /* fail-open, as before */ }

try {
  const { findProject, loadRules, evaluate, toHookOutput, journal } = require('./rules-guard.cjs');
  const proj = findProject(ev.cwd);
  const { rules, warnings } = loadRules(path.join(__dirname, 'base-rules.json'), proj && proj.dir);
  const result = evaluate(ev, rules);
  journal(proj && proj.dir, ev, result);
  const out = toHookOutput(result, warnings);
  if (out) process.stdout.write(JSON.stringify(out));
} catch { /* never break the call */ }
process.exit(0);
