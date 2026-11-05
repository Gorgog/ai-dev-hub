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
// A report is a line that starts with the phrase. Before it: a list marker (`-`, `1.`), bold, a heading, an emoji; a
// quote («> …») is a relay of someone else's report. After it: a sign (`:`, `,`, `—`, `(`), the end, an emoji, or
// a word in Latin (HEAD, a key, a sha). A lowercase Russian word goes on as a sentence — a status or a plan («Готово
// к пушу после ревью»); a line that ends with «?» and names no sha is a question («Готово к пушу — когда?»), while
// a report with a question after its sha («Готово к пушу: abc1234. Пушить?») is a report.
const START = /^[ \t*#_-]*(?:\d+[.)][ \t]+)?(?:\p{Extended_Pictographic}\uFE0F?[ \t]*)?[*_]*готово к (пушу|мержу)(?![\p{L}\p{N}])/iu;
const SHA = /\b[0-9a-f]{7,40}\b/;

// 'push' | 'merge' | null.
function isReport(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(START);
    if (!m) continue;
    const rest = line.slice(m[0].length).replace(/^[*_ \t]+/, '');
    if (/^[а-яё]/.test(rest)) continue;
    if (/\?\s*$/.test(line) && !SHA.test(line)) continue;
    return /пушу/i.test(m[1]) ? 'push' : 'merge';
  }
  return null;
}

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

const shas = (text) => [...String(text || '').matchAll(/\b[0-9a-f]{7,40}\b/g)].map((m) => m[0]);
const headOf = (wt) => { try { return git(wt, 'rev-parse', 'HEAD'); } catch { return null; } };

// The copy the report is about. Candidates: the repo/ or worktree of the cwd, then worktrees/<name> named in the
// text (and present). The first whose HEAD the text names wins (a session in its own copy may mention a neighbour;
// a session may report about another copy: H01 other-worktree); none — the own copy, else the first named one.
function target(cwd, text, proj) {
  if (!proj) return null;
  const rel = real(cwd).slice(real(proj.dir).length).replace(/^\/+/, '').split('/');
  const own = rel[0] === 'repo' ? path.join(proj.dir, 'repo') : rel[0] === 'worktrees' && rel[1] ? path.join(proj.dir, 'worktrees', rel[1]) : null;
  const named = [...String(text || '').matchAll(/worktrees\/([\w.-]+)/g)].map((m) => path.join(proj.dir, 'worktrees', m[1]))
    .filter((d) => d !== own && fs.existsSync(path.join(d, '.git')));
  const cands = [...(own ? [own] : []), ...named];
  const said = shas(text);
  return cands.find((d) => { const h = headOf(d); return h && said.some((s) => h.startsWith(s)); }) || cands[0] || null;
}

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

// The base of the branch: `base` of checks.json, else the trunk — local `main`, else `master`. Not the branch of the
// main working tree: repo/ often stands on a task branch or a detached HEAD. null — no trunk, or this is the trunk.
function baseOf(wt, cfg) {
  if (cfg && typeof cfg.base === 'string' && cfg.base) return cfg.base;
  const current = git(wt, 'branch', '--show-current');
  for (const b of ['main', 'master']) {
    try { git(wt, 'rev-parse', '--verify', '-q', `refs/heads/${b}`); } catch { continue; }
    return b === current ? null : b;
  }
  return null;
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
