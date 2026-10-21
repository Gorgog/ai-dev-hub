#!/usr/bin/env node
// Stop: done-gate. A report «готово к пушу» from a hub project's repo/ or worktree passes only with a clean
// working tree and the HEAD sha printed in it (hub rule 3: numbers from the final HEAD). Otherwise Claude is sent
// back with the reason. The project folder itself (a dispatcher relays sessions' reports there) is not checked.
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const { findProject, HUB_ROOT } = require('./rules-guard.cjs');
const { workTree } = require('./session-start.cjs');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const PHRASE = /(?<!не\s)(?<!не)готово к пушу/i;

function doneGate(ev, hub = HUB_ROOT) {
  if (ev.stop_hook_active) return null;
  if (!PHRASE.test(ev.last_assistant_message || '')) return null;
  const proj = findProject(ev.cwd, hub);
  const wt = proj && workTree(ev.cwd, proj);
  if (!wt) return null;
  let sha, dirty;
  try {
    sha = git(wt, 'rev-parse', '--short', 'HEAD').trim();
    dirty = git(wt, 'status', '--porcelain').split(/\r?\n/).filter(Boolean);
  } catch { return null; }
  const problems = [];
  if (dirty.length) problems.push(`рабочее дерево не чистое: ${dirty.slice(0, 5).map((l) => l.slice(3)).join(', ')}`);
  if (!(ev.last_assistant_message || '').includes(sha)) problems.push(`в докладе нет HEAD ${sha}`);
  if (!problems.length) return null;
  return { decision: 'block', reason: `«Готово к пушу» не проходит (правило 3 хаба): ${problems.join('; ')}. Закоммить, прогони проверки на итоговом HEAD и повтори доклад с sha.` };
}

if (require.main === module) {
  let ev = {};
  try { ev = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no input */ }
  try { const r = doneGate(ev); if (r) process.stdout.write(JSON.stringify(r)); } catch { /* never break a stop */ }
}

module.exports = { doneGate };
