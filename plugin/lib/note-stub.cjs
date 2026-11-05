// note-stub (slice 16, handler done-gate): a session that worked and ended without /hub:wind-down leaves a stub
// note in memory/sessions/ — hub rule 9 stops getting lost. SessionEnd writes it (P7: the event comes on /exit,
// Ctrl+C, a closed terminal and archiving in Desktop, with ~1.5 s for the handler); when it did not, the next
// SessionStart of the same folder writes it for the previous session and reminds. The stub's «Дальше» is what the
// next brief of the branch shows (session-start.cjs latestNote): sum the session up from its transcript.
// The transcript is read by JSON fields: start, cwd, branch, tool calls.
'use strict';
const fs = require('fs');
const path = require('path');

const TRUNKS = new Set(['main', 'master', 'develop', 'production']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Work = an edit or this many tool calls: a session that only answered a question needs no note.
const WORK_CALLS = 10;
// The previous session is judged at SessionStart only once its transcript has been quiet this long: younger, it may
// still be alive in another window (its own SessionEnd will come).
const QUIET_MS = 2 * 60_000;

// { start, cwd, branch, work, calls } of a transcript, or null when it cannot be read.
function sessionFacts(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let start = null, cwd = null, branch = null, calls = 0, edits = 0;
  const lines = text.split('\n');
  const parse = (line) => { try { const o = JSON.parse(line); return o && typeof o === 'object' ? o : null; } catch { return null; } };
  // A long session's transcript is tens of MB and SessionEnd has ~1.5 s: only lines that may hold what is needed are
  // parsed — the start, tool calls, the last cwd and branch.
  for (const line of lines) {
    const o = (start === null && line.includes('"cwd"')) || line.includes('"tool_use"') ? parse(line) : null;
    if (!o) continue;
    if (start === null && o.cwd && o.timestamp) start = Date.parse(o.timestamp);
    const content = o.type === 'assistant' && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const c of content) if (c && c.type === 'tool_use') { calls++; if (EDITS.has(c.name)) edits++; }
  }
  for (let i = lines.length - 1; i >= 0 && !(cwd && branch); i--) {
    const o = lines[i].includes('"cwd"') ? parse(lines[i]) : null;
    if (!o) continue;
    cwd = cwd || o.cwd || null;
    branch = branch || o.gitBranch || null;
  }
  return { start: Number.isFinite(start) ? start : null, cwd, branch, calls, work: edits > 0 || calls >= WORK_CALLS };
}

// The key of the notes: the branch (not a trunk), else null — then any note counts.
const keyOf = (branch) => (branch && !TRUNKS.has(branch) ? branch.replace(/^.*\//, '') : null);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sid8 = (sid) => String(sid || '').replace(/[^\w-]/g, '').slice(0, 8);
const pad = (n) => String(n).padStart(2, '0');
const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function notes(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
}

// Wind-down done: a note (not a stub) of this key changed since the session started. Same whole-key rule as
// latestNote: K-7 does not catch K-7-2 or XK-7.
function hasNote(dir, key, since) {
  const re = key && new RegExp(`(^|[^\\w-]|-)${escape(key)}(?!\\w|-\\d)`, 'i');
  return notes(dir).some((f) => {
    if (/-stub-[\w-]+\.md$/.test(f) || (re && !re.test(f.replace(/\.md$/, '')))) return false;
    try { return fs.statSync(path.join(dir, f)).mtimeMs >= (since || 0); } catch { return false; }
  });
}

const hasStub = (dir, sid) => notes(dir).some((f) => f.endsWith(`-stub-${sid8(sid)}.md`));

// Writes the stub of session `sid` unless wind-down or a stub is there or the session did no work; its path or null.
function write(proj, { sid, transcript, cwd, reason, by, now = Date.now() }) {
  if (!proj || !sid8(sid)) return null;
  const dir = path.join(proj.dir, 'memory', 'sessions');
  if (hasStub(dir, sid)) return null;
  const facts = transcript && sessionFacts(transcript);
  if (!facts || !facts.work) return null;
  const key = keyOf(facts.branch);
  if (hasNote(dir, key, facts.start)) return null;
  const file = path.join(dir, `${day(now)}-${key || 'session'}-stub-${sid8(sid)}.md`);
  const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '—');
  const text = [
    `# Заглушка: ${key || 'сессия'} — закрыта без wind-down (${day(now)})`,
    '',
    `Хук хаба (${by}${reason ? `, причина: ${reason}` : ''}) не нашёл заметки этой сессии в memory/sessions/ — правило 9`
      + ' хаба. Это не итог: итог пишет /hub:wind-down.',
    '',
    `- Сессия: ${sid}`,
    `- Папка: ${facts.cwd || cwd || '—'}`,
    `- Ветка: ${facts.branch || '—'}`,
    `- Время (UTC): ${when(facts.start)} — ${when(now)}, вызовов инструментов: ${facts.calls}`,
    `- Транскрипт: ${transcript}`,
    '',
    '## Дальше',
    `- Подвести итог прошлой сессии: /hub:wind-down по транскрипту ${transcript}; заметка wind-down заменяет эту заглушку (удалить её).`,
    '',
  ].join('\n');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, { flag: 'wx' });
  } catch { return null; }
  return file;
}

// SessionEnd: the stub of the session that ends. Its path or null.
function atEnd(ev, proj) {
  return write(proj, { sid: ev.session_id, transcript: ev.transcript_path, cwd: ev.cwd, reason: ev.reason, by: 'SessionEnd' });
}

// SessionStart (startup or clear): the stub of the previous session of this folder — the newest other transcript
// beside this one — when its SessionEnd did not write it. { file, text } for the reminder, or null.
function atStart(ev, proj, { now = Date.now() } = {}) {
  if (!proj || !ev.transcript_path || !['startup', 'clear'].includes(ev.source)) return null;
  const tdir = path.dirname(ev.transcript_path);
  let prev = null;
  try {
    for (const f of fs.readdirSync(tdir)) {
      if (!f.endsWith('.jsonl') || f === `${ev.session_id}.jsonl` || path.join(tdir, f) === ev.transcript_path) continue;
      const mtime = fs.statSync(path.join(tdir, f)).mtimeMs;
      if (!prev || mtime > prev.mtime) prev = { file: path.join(tdir, f), mtime, sid: f.replace(/\.jsonl$/, '') };
    }
  } catch { return null; }
  if (!prev || now - prev.mtime < QUIET_MS) return null;
  const file = write(proj, { sid: prev.sid, transcript: prev.file, cwd: ev.cwd, by: 'SessionStart следующей сессии', now });
  if (!file) return null;
  return { file, text: `Прошлая сессия этой папки закрылась без /hub:wind-down — записана заглушка memory/sessions/${path.basename(file)}. `
    + `Подведи её итог по транскрипту ${prev.file} (wind-down), заглушку удали.` };
}

module.exports = { sessionFacts, hasNote, atEnd, atStart };
