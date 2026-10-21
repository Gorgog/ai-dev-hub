#!/usr/bin/env node
// SessionStart: a short brief of the hub project into Claude's context instead of «read the index first».
// Project, branch and changes; preflight (configs parse, checks background, index limits); the errors index (cut
// to the budget); the latest session note of this branch — its «Дальше». Silent outside projects/<name>/ of the hub.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findProject } = require('./rules-guard.cjs');

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

function latestNote(dir, branch) {
  const sessions = path.join(dir, 'memory', 'sessions');
  if (!branch || !fs.existsSync(sessions)) return null;
  const key = branch.replace(/^.*\//, '');
  const files = fs.readdirSync(sessions).filter((f) => f.endsWith('.md')).sort().reverse();
  for (const f of files) {
    const text = read(path.join(sessions, f)) || '';
    if (!new RegExp(`(^|[^\\w-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text)) continue;
    const m = text.match(/^##\s*Дальше[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
    return { file: `memory/sessions/${f}`, next: m ? m[1].trim().slice(0, NOTE_BUDGET) : '' };
  }
  return null;
}

function buildBrief(cwd) {
  const proj = findProject(cwd);
  if (!proj || !fs.existsSync(proj.dir)) return '';
  const branch = git(cwd, 'branch', '--show-current');
  const changed = git(cwd, 'status', '--porcelain').split('\n').filter(Boolean).length;
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

module.exports = { buildBrief, BUDGET };
