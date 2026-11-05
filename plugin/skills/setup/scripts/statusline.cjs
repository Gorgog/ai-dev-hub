#!/usr/bin/env node
// Status line of Claude Code (settings statusLine, set by /hub:setup): проект · ветка · контекст % · кэш % · кто
// держит тяжёлое. Input — the status line JSON on stdin (workspace.current_dir, context_window.used_percentage and
// current_usage). Runs on every refresh: no git process, the branch comes from the .git files; the holders — from the
// dispatcher's grants (projects/<name>/memory/dispatch-grants.json), an expired grant is free. Never fails: a part it
// cannot read is left out.
'use strict';
const fs = require('fs');
const path = require('path');
const { findProject } = require('../../../hooks/lib/hub.cjs');

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// The branch of the checkout around dir: .git is a folder or a file «gitdir: …» (a worktree).
function branch(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const g = path.join(d, '.git');
    let gd = null;
    try { gd = fs.statSync(g).isDirectory() ? g : null; } catch { /* go up */ }
    if (!gd) { const m = (read(g) || '').match(/^gitdir:\s*(.+)$/m); if (m) gd = path.resolve(d, m[1].trim()); }
    if (gd) {
      const head = (read(path.join(gd, 'HEAD')) || '').trim();
      const ref = (head.match(/^ref:\s*refs\/heads\/(.+)$/) || [])[1];
      return ref || (head ? head.slice(0, 7) : null);
    }
    if (path.dirname(d) === d) return null;
  }
}

function holders(proj) {
  let g;
  try { g = JSON.parse(read(path.join(proj.dir, 'memory', 'dispatch-grants.json')) || '{}'); } catch { return null; }
  const live = (k) => g && g[k] && g[k].holder && (!g[k].until || Date.parse(g[k].until) > Date.now()) ? g[k].holder : null;
  const parts = [`тяжёлое: ${live('heavy') || 'свободно'}`];
  if (live('medium')) parts.push(`среднее: ${live('medium')}`);
  return parts.join(' · ');
}

function line(input) {
  const dir = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
  const proj = findProject(dir);
  const parts = [proj ? proj.name : path.basename(dir)];
  const b = branch(dir);
  if (b) parts.push(b);
  const cw = input.context_window || {};
  const u = cw.current_usage || {};
  const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  if (total > 0 && Number.isFinite(cw.used_percentage)) parts.push(`контекст ${Math.round(cw.used_percentage)}%`);
  if (total > 0) parts.push(`кэш ${Math.round((100 * (u.cache_read_input_tokens || 0)) / total)}%`);
  if (proj) { const h = holders(proj); if (h) parts.push(h); }
  return parts.join(' · ');
}

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') || {}; } catch { /* a broken input — what is known */ }
try { process.stdout.write(line(input) + '\n'); } catch { process.stdout.write('\n'); }
