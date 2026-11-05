// done-gate (slice 16): a report «готово к пушу» / «готово к мержу» judged by facts, not by the phrase.
// A report is a line that starts with the phrase (slice 11: 35 of 35 v1 blocks were on statuses and plans that only
// mention it). The copy it is about — the worktree it names, else the repo/ or worktree of the cwd. Basics (hook
// stop.d/10, stage on): clean tree, a sha of HEAD in the text. Facts (stop.d/11, canary): in a project with
// checks.json — `checks.cjs --full` green on that HEAD of a clean tree (last-full.json, written by checks.cjs into the
// git dir of the worktree); a push report — the branch is not behind its base.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const run = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const git = (cwd, ...a) => run(cwd, ...a).trim();
// A quote («> …») is a relay of someone else's report; a list marker, bold or a heading is still the report itself.
const REPORT = /^[ \t*#_-]*готово к (пушу|мержу)[*_ \t]*[:—–(,.!-]/im;
const PHRASE = /^[ \t*#_-]*готово к (пушу|мержу)[*_ \t]*$/im;

// 'push' | 'merge' | null.
function isReport(text) {
  const m = String(text || '').match(REPORT) || String(text || '').match(PHRASE);
  if (!m) return null;
  return /пушу/i.test(m[1]) ? 'push' : 'merge';
}

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

// The copy the report is about: worktrees/<name> named in it (and present), else the copy of the cwd, else null.
function target(cwd, text, proj) {
  if (!proj) return null;
  for (const m of String(text || '').matchAll(/worktrees\/([\w.-]+)/g)) {
    const d = path.join(proj.dir, 'worktrees', m[1]);
    if (fs.existsSync(path.join(d, '.git'))) return d;
  }
  const rel = real(cwd).slice(real(proj.dir).length).replace(/^\/+/, '').split('/');
  if (rel[0] === 'repo') return path.join(proj.dir, 'repo');
  if (rel[0] === 'worktrees' && rel[1]) return path.join(proj.dir, 'worktrees', rel[1]);
  return null;
}

const shas = (text) => [...String(text || '').matchAll(/\b[0-9a-f]{7,40}\b/g)].map((m) => m[0]);

// Problems of the copy itself: a dirty tree, no sha of HEAD in the text. Unreadable git — no verdict ([]).
function basics(text, wt) {
  let head, dirty;
  try {
    head = git(wt, 'rev-parse', 'HEAD');
    dirty = run(wt, 'status', '--porcelain').split(/\r?\n/).filter(Boolean); // not trimmed: « M a.txt»
  } catch { return []; }
  const problems = [];
  if (dirty.length) problems.push(`рабочее дерево не чистое: ${dirty.slice(0, 5).map((l) => l.slice(3)).join(', ')}`);
  if (!shas(text).some((s) => head.startsWith(s))) problems.push(`в докладе нет HEAD ${head.slice(0, 7)}`);
  return problems;
}

const lastFullPath = (wt) => git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'hub/last-full.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// The base of the branch: `base` of checks.json, else the branch of the main working tree (the first of
// `git worktree list`). null — none, or this copy is the main one.
function baseOf(wt, cfg) {
  if (cfg && typeof cfg.base === 'string' && cfg.base) return cfg.base;
  const list = git(wt, 'worktree', 'list', '--porcelain').split(/\r?\n/);
  const main = (list.find((l) => l.startsWith('worktree ')) || '').slice('worktree '.length);
  const branch = (list.find((l) => l.startsWith('branch ')) || '').replace(/^branch refs\/heads\//, '');
  return branch && real(main) !== real(wt) ? branch : null;
}

// Problems of the facts: the full run on the final HEAD (with checks.json), behind the base (push reports).
function facts(wt, proj, kind) {
  let head;
  try { head = git(wt, 'rev-parse', 'HEAD'); } catch { return []; }
  const cfgFile = path.join(proj.dir, 'checks.json');
  const cfg = fs.existsSync(cfgFile) ? readJson(cfgFile) || {} : null;
  const problems = [];
  if (cfg) {
    let file = null;
    try { file = lastFullPath(wt); } catch { /* no git dir — no run either */ }
    const last = file && readJson(file);
    if (!last || typeof last.sha !== 'string') problems.push(`checks --full не прогнан на итоговом HEAD ${head.slice(0, 7)}`);
    else if (last.sha !== head) {
      let after = [];
      try { after = git(wt, 'log', '--format=%h %s', `${last.sha}..HEAD`).split(/\r?\n/).filter(Boolean); } catch { /* sha gone (rebase) */ }
      problems.push(`checks --full прогнан на ${last.sha.slice(0, 7)}, а итоговый HEAD ${head.slice(0, 7)}`
        + (after.length ? ` — после прогона коммиты: ${after.slice(0, 3).join('; ')}${after.length > 3 ? ` и ещё ${after.length - 3}` : ''}` : ''));
    } else if (last.code !== 0) {
      const bad = (Array.isArray(last.steps) ? last.steps : []).filter((s) => s && s.status === 'FAIL').map((s) => s.name);
      problems.push(`последний checks --full на HEAD красный${bad.length ? `: ${bad.join(', ')}` : ''}`);
    } else if (last.clean !== true) problems.push('checks --full на HEAD шёл на грязном дереве — прогон не того, что в коммите');
  }
  if (kind === 'push') {
    try {
      const base = baseOf(wt, cfg);
      const n = base ? Number(git(wt, 'rev-list', '--count', `HEAD..${base}`)) : 0;
      if (n > 0) problems.push(`ветка отстала от ${base} на ${n} коммит(ов) — подтяни базу (rebase или merge)`);
    } catch { /* an unreadable base proves nothing */ }
  }
  return problems;
}

module.exports = { isReport, target, basics, facts, lastFullPath, baseOf };
