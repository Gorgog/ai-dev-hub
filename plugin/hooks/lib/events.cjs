// Event journal of the delivery (slice 12): every delivery — shown, dropped by a limit, a deny / block / ask — and
// every outcome of a «prevented» window — repeat, prevented, expired — is one JSON line in
// <data>/events/<YYYY-MM>.jsonl, the month of its `at`. All lines of one hook call go in one write to a file opened
// for append (O_APPEND; P15: 7 processes with kill -9 tore none at this size); a line stays small, fields are cut;
// every write starts with a newline (slice 32), so empty lines are normal.
// The format is shared with the memory events (slice 14): {at, kind, lesson | rule, session_id, agent_id,
// tool_use_id, epoch, model, mode, ...}. The reader skips empty lines and skips a torn line and counts it.
// usage: node events.cjs stats [YYYY-MM]  — the «prevented» counter from the journal of the hooks' data folder
'use strict';
const fs = require('fs');
const path = require('path');
const { dir: dataDir } = require('./journal.cjs');

const FIELD_MAX = 200;
const MONTH = /^\d{4}-\d{2}$/;

const cut = (v) => {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX)}…` : s;
};

function append(list, dir = dataDir()) {
  if (!list || !list.length) return;
  const now = new Date().toISOString();
  const byMonth = new Map();
  for (const e of list) {
    const { at: given, ...rest } = e;
    const at = typeof given === 'string' && MONTH.test(given.slice(0, 7)) ? given : now;
    const line = { at };
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) line[k] = cut(v);
    const m = at.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) || '') + JSON.stringify(line) + '\n');
  }
  const d = path.join(dir, 'events');
  fs.mkdirSync(d, { recursive: true });
  for (const [m, text] of byMonth) {
    // Always a leading newline, no tail read (slice 32, the race of H22): a kill tears a write between 4 KB pages, and
    // a fragment of a killed writer could land between «read the last byte» and this write — the first line of this
    // call then glued onto it and was lost with it. A write that starts on its own line never glues; the killed
    // writer's own fragment stays a torn line of its own (skipped, counted), empty lines are skipped.
    const fd = fs.openSync(path.join(d, `${m}.jsonl`), 'a');
    try { fs.writeSync(fd, `\n${text}`); } finally { fs.closeSync(fd); }
  }
}

const files = (dir = dataDir()) => {
  const d = path.join(dir, 'events');
  try { return fs.readdirSync(d).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(d, f)); } catch { return []; }
};

function read(f) {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { return { events: [], torn: 0 }; }
  const events = [];
  let torn = 0;
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      const e = JSON.parse(l);
      if (e && typeof e === 'object' && !Array.isArray(e)) events.push(e); else torn++;
    } catch { torn++; }
  }
  return { events, torn };
}

// The «prevented» counter: per lesson — shows, windows closed without a repeat (prevented), repeats inside the window,
// late repeats (after it), windows cut by the end of the epoch (expired); measured — the lesson came with a detector.
// A deny / block / ask carrying a lesson is a show of it. Items without a lesson are counted per rule (the module).
function stats(list) {
  const lessons = {}, rules = {};
  const total = { shown: 0, measured: 0, prevented: 0, repeat: 0, expired: 0, rate: null };
  const L = (id) => (lessons[id] ||= { shown: 0, prevented: 0, repeat: 0, late: 0, expired: 0, measured: false });
  for (const e of list) {
    const show = e.kind === 'shown' || ((e.kind === 'deny' || e.kind === 'block' || e.kind === 'ask') && e.lesson);
    if (!e.lesson) {
      if (e.rule) { const r = (rules[e.rule] ||= { shown: 0, dropped: 0, deny: 0, block: 0, ask: 0 }); if (e.kind in r) r[e.kind]++; }
      if (e.kind === 'shown') total.shown++;
      continue;
    }
    const l = L(e.lesson);
    if (show) {
      l.shown++; total.shown++;
      if (e.detector) { l.measured = true; total.measured++; }
    } else if (e.kind === 'prevented') { l.prevented++; total.prevented++; }
    else if (e.kind === 'repeat' && e.window) { l.repeat++; total.repeat++; }
    else if (e.kind === 'repeat') l.late++;
    else if (e.kind === 'expired') { l.expired++; total.expired++; }
  }
  if (total.prevented + total.repeat) total.rate = total.prevented / (total.prevented + total.repeat);
  return { lessons, rules, total };
}

if (require.main === module) {
  const [cmd, month] = process.argv.slice(2);
  if (cmd !== 'stats' || (month && !MONTH.test(month))) { console.error('usage: node events.cjs stats [YYYY-MM]'); process.exit(2); }
  const list = files().filter((f) => !month || path.basename(f) === `${month}.jsonl`);
  let torn = 0;
  const all = list.flatMap((f) => { const r = read(f); torn += r.torn; return r.events; });
  console.log(JSON.stringify({ files: list, torn, ...stats(all) }, null, 2));
}

module.exports = { append, files, read, stats };
