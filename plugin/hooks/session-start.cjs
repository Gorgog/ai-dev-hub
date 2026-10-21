#!/usr/bin/env node
// SessionStart: a short brief of the hub project into Claude's context instead of «read the index first».
// Project, branch and changes; preflight (configs parse, checks background, index limits); the errors index (cut
// to the budget); the latest session note of this branch — its «Дальше». Silent outside projects/<name>/ of the hub.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findProject, HUB_ROOT } = require('./rules-guard.cjs');

const BUDGET = 9500;
const NOTE_BUDGET = 1500;

const git = (cwd, ...a) => {
  try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

function preflight(dir) {
  const warn = [];
  for (const f of ['rules.json', 'dispatch-rules.json', 'checks.json']) {
    const s = read(path.join(dir, f));
    if (s === null) continue;
    try { JSON.parse(s); } catch { warn.push(`${f} не разбирается — его правила не действуют`); }
  }
  if (fs.existsSync(path.join(dir, 'checks.json')) && !fs.existsSync(path.join(dir, 'checks-baseline', 'BASE'))) {
    warn.push('нет фона checks: `checks --full` не увидит поломок чужого кода (фон пишет `--record-baseline` на чистой базе)');
  }
  const idx = read(path.join(dir, 'memory', 'errors-index.md'));
  if (idx !== null) {
    const lines = idx.split(/\r?\n/);
    const long = lines.filter((l) => l.length > 160).length;
    if (lines.length > 150 || long) warn.push(`индекс ошибок: ${lines.length} строк (лимит 150), длиннее 160 знаков — ${long}`);
  }
  return warn;
}

const TRUNKS = new Set(['main', 'master', 'develop', 'production']);

// The note OF this branch: the key in the file name or the title line — not a passing mention in the body.
function latestNote(dir, branch) {
  const sessions = path.join(dir, 'memory', 'sessions');
  if (!branch || TRUNKS.has(branch) || !fs.existsSync(sessions)) return null;
  const key = branch.replace(/^.*\//, '');
  // A whole key: K-7 does not catch K-7-2 (a sibling branch) or XK-7; K-7-review (a topic after it) is fine.
  const re = new RegExp(`(^|[^\\w-]|-)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w|-\\d)`, 'i');
  const notes = fs.readdirSync(sessions).filter((f) => f.endsWith('.md')).map((f) => {
    const file = path.join(sessions, f);
    const text = read(file) || '';
    const title = text.split(/\r?\n/).find((l) => l.trim()) || '';
    return { f, text, own: re.test(f.replace(/\.md$/, '')) || re.test(title), mtime: fs.statSync(file).mtimeMs };
  }).filter((n) => n.own).sort((a, b) => b.mtime - a.mtime || b.f.localeCompare(a.f));
  if (!notes.length) return null;
  const m = notes[0].text.match(/^##\s*Дальше[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return { file: `memory/sessions/${notes[0].f}`, next: m ? m[1].trim().slice(0, NOTE_BUDGET) : '' };
}

// The project's own git: repo/ or worktrees/<branch> under cwd; the project folder itself — its repo/.
function workTree(cwd, proj) {
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch { /* as given */ }
  const rel = String(real).replace(/\\/g, '/').slice(proj.dir.length).replace(/^\/+/, '').split('/');
  if (rel[0] === 'repo') return path.join(proj.dir, 'repo');
  if (rel[0] === 'worktrees' && rel[1]) return path.join(proj.dir, 'worktrees', rel[1]);
  return null;
}

function buildBrief(cwd, hub = HUB_ROOT) {
  const proj = findProject(cwd, hub);
  if (!proj || !fs.existsSync(proj.dir)) return '';
  const wt = workTree(cwd, proj) || (fs.existsSync(path.join(proj.dir, 'repo')) ? path.join(proj.dir, 'repo') : null);
  const branch = wt ? git(wt, 'branch', '--show-current') : '';
  const changed = wt ? git(wt, 'status', '--porcelain').split('\n').filter(Boolean).length : 0;
  const head = [`Бриф хаба: ${proj.name} · ветка ${branch || '—'} · изменённых ${changed}`];
  const warn = preflight(proj.dir);
  if (warn.length) head.push('Предполётная проверка:', ...warn.map((w) => `- ${w}`));
  const note = latestNote(proj.dir, branch);
  const tail = [];
  if (note) tail.push(`Последняя заметка этой ветки: ${note.file}`, note.next ? `Дальше:\n${note.next}` : '');
  const idx = read(path.join(proj.dir, 'memory', 'errors-index.md'));
  let body = '';
  if (idx !== null) {
    const room = BUDGET - head.join('\n').length - tail.join('\n').length - 200;
    body = idx.length <= room ? idx
      : `${idx.slice(0, Math.max(0, room)).replace(/\n[^\n]*$/, '')}\n… индекс обрезан под бюджет брифа — полностью: memory/errors-index.md`;
  }
  return [...head, body ? `Правила из ошибок (memory/errors-index.md):\n${body}` : '', ...tail].filter(Boolean).join('\n').slice(0, BUDGET);
}

if (require.main === module) {
  let ev = {};
  try { ev = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no input */ }
  try { const b = buildBrief(ev.cwd || process.cwd()); if (b) process.stdout.write(b + '\n'); } catch { /* never break a session start */ }
}

module.exports = { buildBrief, workTree, BUDGET };
