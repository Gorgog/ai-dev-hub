// Health of the hub at every session start: configs parse, node ≥ 22 with node:sqlite, the hub root is found, and the
// hooks run from a clean checkout on main (P17: the hooks run straight from the working tree of the hub's main copy,
// so an uncommitted edit of plugin/ or another branch there is already live in every session). [] — healthy.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function health({ plugin, hub, registryProblems = [] }) {
  const p = [];
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) p.push(`node ${process.versions.node} — нужен ≥ 22`);
  try { require('node:sqlite'); } catch (e) { p.push(`node:sqlite не грузится (${String(e.message).split('\n')[0]}) — память на FTS5 не заработает`); }
  if (!fs.existsSync(path.join(hub, 'projects'))) p.push(`корень хаба не найден: в ${hub} нет projects/ (AI_DEV_HUB или маркетплейс hub в ~/.claude/settings.json)`);
  for (const f of ['hooks/hooks.json', 'hooks/base-rules.json']) {
    try { JSON.parse(fs.readFileSync(path.join(plugin, f), 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') p.push(`plugin/${f} не разбирается — ${String(e.message).split('\n')[0]}`);
    }
  }
  p.push(...registryProblems);
  const root = path.dirname(plugin);
  let branch = null;
  try { branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD'); } catch { /* not a git checkout: nothing to compare */ }
  if (branch !== null) {
    if (branch !== 'main') p.push(`хуки исполняются из ${root} не на main (ветка ${branch})`);
    let dirty = [];
    try { dirty = git(root, 'status', '--porcelain', '--', path.basename(plugin)).split('\n').filter(Boolean); } catch { /* as clean */ }
    if (dirty.length) p.push(`незакоммиченные правки plugin/ в ${root} уже в бою: ${dirty.slice(0, 5).map((l) => l.slice(3)).join(', ')}`);
  }
  return p;
}

module.exports = { health };
