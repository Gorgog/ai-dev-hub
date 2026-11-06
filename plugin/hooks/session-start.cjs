#!/usr/bin/env node
// SessionStart: a short brief of the hub project into Claude's context instead of «read the index first».
// Project, branch and changes; preflight (configs parse, checks background, index limits); the errors index (cut
// to the budget); the latest session note of this branch — its «Дальше». Silent outside projects/<name>/ of the hub.
// A project with memory v2 (memory/lessons/) on the canary of memory-core (slice 29) gets the core of lessons
// (status core, ≤ CORE_MAX lines) in place of the index: the rest comes by touch (the lesson hooks) and /hub:recall.
// A library of the modules sessionstart.d/09-memory-core.cjs and 10-memory-brief.cjs.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findProject, HUB_ROOT } = require('./rules-guard.cjs');

const BUDGET = 9500;
const NOTE_BUDGET = 1500;
const CORE_MAX = 15;
const CORE_RECORD = path.join(__dirname, '..', 'mechanisms', 'memory-core.json');

const git = (cwd, ...a) => {
  try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

function preflight(dir, { core = false } = {}) {
  const warn = [];
  for (const f of ['rules.json', 'dispatch-rules.json', 'checks.json']) {
    const s = read(path.join(dir, f));
    if (s === null) continue;
    try { JSON.parse(s); } catch { warn.push(`${f} не разбирается — его правила не действуют`); }
  }
  if (fs.existsSync(path.join(dir, 'checks.json')) && !fs.existsSync(path.join(dir, 'checks-baseline', 'BASE'))) {
    warn.push('нет фона checks: `checks --full` не увидит поломок чужого кода (фон пишет `--record-baseline` на чистой базе)');
  }
  // In the core mode the index is a derived export the brief says not to read: its limits are not the session's concern.
  const idx = core ? null : read(path.join(dir, 'memory', 'errors-index.md'));
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

const readJsonSafe = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// brief.json {"indexSections": [heading prefixes]}: those `##` sections of the index in full, every other one as a
// single «по касанию» line with its keys — the index stays whole on disk, the brief stays within the budget.
function pickSections(idx, cfg) {
  const want = cfg && Array.isArray(cfg.indexSections) ? cfg.indexSections.map((s) => String(s).toLowerCase()) : null;
  if (!want) return idx;
  const parts = idx.split(/^(?=## )/m);
  const out = [parts[0].trimEnd()];
  const touch = [];
  for (const sec of parts.slice(1)) {
    const heading = sec.split(/\r?\n/)[0].replace(/^##\s*/, '').trim();
    if (want.some((w) => heading.toLowerCase().startsWith(w))) out.push(sec.trimEnd());
    else touch.push(`- по касанию: ${heading}`);
  }
  if (touch.length) out.push('## Остальное — по касанию (детали: grep по ключам в memory/errors-index.md)', ...touch);
  return out.join('\n\n');
}

// The project's own git: repo/ or worktrees/<branch> under cwd; the project folder itself — its repo/.
function workTree(cwd, proj) {
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch { /* as given */ }
  const c = String(real).replace(/\\/g, '/');
  // Only a path inside the project folder: the hub root and its folders map to the hub's own project too.
  if (!c.startsWith(`${proj.dir}/`)) return null;
  const rel = c.slice(proj.dir.length).replace(/^\/+/, '').split('/');
  if (rel[0] === 'repo') return path.join(proj.dir, 'repo');
  if (rel[0] === 'worktrees' && rel[1]) return path.join(proj.dir, 'worktrees', rel[1]);
  return null;
}

// ---------- the core of lessons (memory v2, slice 29) ----------

const LESSONS = (dir) => path.join(dir, 'memory', 'lessons');
const KIND_ORDER = { once: 0, rule: 1, knowledge: 2, decision: 3 };

// Live lessons as the brief needs them: the core (first line and id; class «once» first, then by date and id) and the
// count of the rest by touch. Only lessons the write check accepts, as for the triggers (store.ensureTriggers): a file
// written past the hook — a source «внешний» of any case, a push command or a URL in the text, NUL, broken
// frontmatter — never comes as a rule of the hub and is not counted (memory-check names it). The memory library is
// required here, not at the top: stop.cjs and the v1 entry of this file load it and must not depend on lib/memory.
// null — no lessons/ or no library: the brief falls back to the index, the start never stays without a brief.
function lessonLayers(dir) {
  let files = [], fmt;
  try { files = fs.readdirSync(LESSONS(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort(); } catch { return null; }
  try { fmt = require('../lib/memory/format.cjs'); } catch { return null; }
  const core = [];
  let touch = 0;
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(LESSONS(dir), f)); } catch { continue; }
    if (fmt.validateLesson(raw, { file: `memory/lessons/${f}` }).length) continue;
    const { meta, body } = fmt.parseLesson(raw.toString('utf8'));
    const first = (body.find((l) => l.trim()) || '').trim();
    if (meta.status === 'core' && first) core.push({ id: f.slice(0, -3), first, kind: meta.kind, created: String(meta.created || '') });
    else if (meta.status === 'core' || meta.status === 'active') touch++;
  }
  const rank = (l) => (Object.hasOwn(KIND_ORDER, l.kind) ? KIND_ORDER[l.kind] : 9);
  core.sort((a, b) => rank(a) - rank(b) || a.created.localeCompare(b.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { core, touch };
}

// The memory-core module gives the brief where the spine runs it (its record on, or canary with the project's
// canary.json naming its id or handler — the same test as run.cjs) and the project has memory/lessons/. One decision
// per start (review 1, M1): the core module runs before memory-brief and marks the event it gave the brief for;
// memory-brief steps aside only for a marked event. The spine skipping the core module (no cwd, the canary changed
// meanwhile) or the module failing leaves the event unmarked — the index brief comes: never two, never none.
const coreGiven = new WeakSet();
function coreOn(proj) {
  if (!proj || !fs.existsSync(LESSONS(proj.dir))) return false;
  const rec = readJsonSafe(CORE_RECORD);
  if (!rec || rec.stage === 'off') return false;
  if (rec.stage === 'on') return true;
  const canary = readJsonSafe(path.join(proj.dir, 'canary.json'));
  return rec.stage === 'canary' && !!canary && Array.isArray(canary.mechanisms)
    && canary.mechanisms.some((m) => m === rec.id || m === rec.handler);
}

const lessonsWord = (n) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? 'урок' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'урока' : 'уроков';
};

// The core block within `room` characters: whole lines only, what does not fit goes to the «по касанию» line by id.
function coreBlock(layers, room) {
  const shown = layers.core.slice(0, CORE_MAX);
  const over = layers.core.slice(CORE_MAX).map((l) => l.id);
  const foot = () => [
    over.length ? `Ядро сверх ${CORE_MAX} — по касанию: ${over.join(', ')}` : '',
    `По касанию — ещё ${layers.touch} ${lessonsWord(layers.touch)}: урок с триггером \`when\` хук подаёт при касании темы, любой — /hub:recall. `
      + 'memory/errors-index.md — выводимый экспорт, не читать.',
  ].filter(Boolean);
  const lines = shown.map((l) => `- ${l.first} [${l.id}]`);
  const text = () => ['Ядро уроков (memory/lessons/, status core) — действует всегда:', ...lines, ...foot()].join('\n');
  while (text().length > room && lines.length) { lines.pop(); over.unshift(shown[lines.length].id); }
  return text();
}

function buildBrief(cwd, hub = HUB_ROOT, version = '', { core = false } = {}) {
  const proj = findProject(cwd, hub);
  if (!proj || !fs.existsSync(proj.dir)) return '';
  const layers = core ? lessonLayers(proj.dir) : null;
  const wt = workTree(cwd, proj) || (fs.existsSync(path.join(proj.dir, 'repo')) ? path.join(proj.dir, 'repo') : null);
  const branch = wt ? git(wt, 'branch', '--show-current') : '';
  const changed = wt ? git(wt, 'status', '--porcelain').split('\n').filter(Boolean).length : 0;
  const head = [`Бриф хаба: ${proj.name} · ветка ${branch || '—'} · изменённых ${changed}${version ? ` · хаб ${version}` : ''}`];
  const warn = preflight(proj.dir, { core: !!layers });
  if (layers && layers.core.length > CORE_MAX) {
    warn.push(`ядро уроков: ${layers.core.length} > ${CORE_MAX} — лишние перевести в active (/hub:memory-gc), сверх ${CORE_MAX} подаются по касанию`);
  }
  if (warn.length) head.push('Предполётная проверка:', ...warn.map((w) => `- ${w}`));
  const note = latestNote(proj.dir, branch);
  const tail = [];
  if (note) tail.push(`Последняя заметка этой ветки: ${note.file}`, note.next ? `Дальше:\n${note.next}` : '');
  const room = BUDGET - head.join('\n').length - tail.join('\n').length - 200;
  if (layers) return [...head, coreBlock(layers, room), ...tail].filter(Boolean).join('\n').slice(0, BUDGET);
  const raw = read(path.join(proj.dir, 'memory', 'errors-index.md'));
  let idx = raw;
  const cfg = readJsonSafe(path.join(proj.dir, 'brief.json'));
  if (raw !== null && cfg && Array.isArray(cfg.indexSections)) {
    // Too long with a long note? The last chosen sections step down to «по касанию» lines — pointers stay, nothing
    // is cut in the middle.
    const chosen = [...cfg.indexSections];
    idx = pickSections(raw, { indexSections: chosen });
    while (idx.length > room && chosen.length) { chosen.pop(); idx = pickSections(raw, { indexSections: chosen }); }
  }
  let body = '';
  if (idx !== null) {
    body = idx.length <= room ? idx
      : `${idx.slice(0, Math.max(0, room)).replace(/\n[^\n]*$/, '')}\n… индекс обрезан под бюджет брифа — полностью: memory/errors-index.md`;
  }
  return [...head, body ? `Правила из ошибок (memory/errors-index.md):\n${body}` : '', ...tail].filter(Boolean).join('\n').slice(0, BUDGET);
}

// The brief as delivery items (decision 05.11): the header and the rules (index or core) are instructions of the hub
// and go as they are; the note of the session — written by a model — is data from memory, framed by the delivery.
// Where the note begins: buildBrief puts it last. The first match: rules quoting this line only move more text into
// the frame, never a note's text out of it.
const NOTE = '\nПоследняя заметка этой ветки: ';
function briefItems(brief) {
  if (!brief) return null;
  const at = brief.indexOf(NOTE);
  if (at < 0) return { items: [{ text: brief, priority: 'info', key: 'memory-brief' }] };
  return { items: [
    { text: brief.slice(0, at), priority: 'info', key: 'memory-brief' },
    { text: brief.slice(at + 1), priority: 'info', key: 'memory-brief-note', source: 'memory' },
  ] };
}

module.exports = { buildBrief, briefItems, coreOn, coreGiven, lessonLayers, coreBlock, workTree, BUDGET, CORE_MAX };

// v1 entry of SessionStart, kept for sessions started before the spine (their hooks.json calls this file): the
// brief now comes from sessionstart.d/10-memory-brief.cjs through the spine.
if (require.main === module) require('./run.cjs').cli('SessionStart');
