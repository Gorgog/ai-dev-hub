// Memory events: `memory/events/<YYYY-MM>.jsonl`, one line per event, written by ONE appendFileSync-like write on an
// O_APPEND descriptor (P15: 0 torn lines of 14 000 under kill -9 while lines stay small; ~256 KB lines tore). The
// line is the format shared with the delivery log (slice 12):
//   {at, kind, lesson|rule, session_id, agent_id, tool_use_id, epoch, model, mode} + into, note when needed.
// Memory kinds: shown, repeat, merged (lesson → into), superseded (lesson → into), retired. Counters are a fold.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_LINE = 4096;
const ORDER = ['at', 'kind', 'lesson', 'rule', 'session_id', 'agent_id', 'tool_use_id', 'epoch', 'model', 'mode', 'into', 'note'];
const COUNTED = ['shown', 'repeat', 'merged', 'superseded', 'retired'];

function eventLine(ev) {
  if (!ev || (typeof ev.lesson !== 'string' && typeof ev.rule !== 'string')) throw new Error('событие памяти: нужен lesson (или rule)');
  if (!/^[a-z_-]{1,32}$/.test(String(ev.kind || ''))) throw new Error(`событие памяти: kind «${ev.kind}»`);
  const o = {};
  for (const k of ORDER) if (ev[k] !== undefined) o[k] = ev[k];
  if (!o.at) o.at = new Date().toISOString();
  o.at = String(o.at);
  // Other short fields of the delivery log ride along after the known ones, in name order.
  for (const k of Object.keys(ev).sort()) {
    if (!ORDER.includes(k) && /^[a-z_]{1,32}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof ev[k])) o[k] = ev[k];
  }
  let line = `${JSON.stringify(o)}\n`;
  while (Buffer.byteLength(line) > MAX_LINE && typeof o.note === 'string' && o.note.length) {
    const over = Buffer.byteLength(line) - MAX_LINE;
    o.note = `${o.note.slice(0, Math.max(0, o.note.length - Math.ceil(over / 2) - 2))}…`;
    if (o.note === '…') { delete o.note; }
    line = `${JSON.stringify(o)}\n`;
  }
  if (Buffer.byteLength(line) > MAX_LINE) throw new Error(`событие памяти длиннее ${MAX_LINE} байт`);
  return { line, month: /^\d{4}-\d\d/.test(o.at) ? o.at.slice(0, 7) : new Date().toISOString().slice(0, 7) };
}

// H22 (slice 26, probe in ~/hub-data/probes/26): a SIGKILL tears a write only between 4 KB pages (the kernel checks a
// fatal signal between page-sized chunks), and «read the last byte, then write» raced: a killed writer's fragment
// landed in between and a neighbour's whole event glued onto it. So the write goes under a kernel lock — node:sqlite
// BEGIN EXCLUSIVE on memory/.events.lock.db (an fcntl lock: dropped by the kernel when its holder dies) — and inside
// it: a leading \n, pad with bare \n up to the page boundary when the line would cross it, one write. A line
// (≤ MAX_LINE ≤ PAGE) then lies in one page and a kill cannot tear it. Without node:sqlite: a \n frame, no tail read —
// no glue, a torn fragment stays its own (skipped) line. Local file systems only: NFS/FUSE keep neither guarantee.
const PAGE = 4096;
// The lock is held for tens of µs. Waiting is our own poll every ~1 ms (review 2): SQLite's busy handler sleeps up to
// tens of ms and starves under 8+ writers — the wait ran out with nobody stuck. Past WAIT_MS the holder is stuck.
const WAIT_MS = 400;
const nap = new Int32Array(new SharedArrayBuffer(4));
const LOCK = '.events.lock.db'; // outside events/: readers and the memory commit never see it
if (MAX_LINE > PAGE) throw new Error('MAX_LINE больше страницы: строка события не помещается в одну страницу');
const sqlite = require('./sqlite.cjs');
const STUCK_MS = 5000; // the lock was not taken: this process frames its next events at once for a while (review 1)
let stuckUntil = 0;

function appendEvent(memDir, ev) {
  const { line, month } = eventLine(ev);
  const dir = path.join(memDir, 'events');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${month}.jsonl`);
  const D = sqlite();
  // A holder that is stuck (stopped, hung) must not hold a hook: past WAIT_MS — the \n frame, as without node:sqlite,
  // and so for STUCK_MS more in this process (a Stop mirrors many events: one wait, not one per event).
  const frame = () => { fs.appendFileSync(file, `\n${line}`); };
  if (!D || Date.now() < stuckUntil) { frame(); return line; }
  let db;
  try {
    db = new D(path.join(memDir, LOCK), { timeout: 0 });
    for (const t0 = Date.now(); ;) {
      try { db.exec('BEGIN EXCLUSIVE'); break; } catch (e) {
        if (!/locked|busy/i.test(String(e && e.message)) || Date.now() - t0 >= WAIT_MS) throw e;
        Atomics.wait(nap, 0, 0, 0.5 + Math.random());
      }
    }
  } catch {
    stuckUntil = Date.now() + STUCK_MS;
    try { if (db) db.close(); } catch { /* closed */ }
    frame();
    return line;
  }
  try {
    const fd = fs.openSync(file, 'a+');
    try {
      // Always a leading \n, no tail read (review 1): a framed writer works without the lock, and its fragment may land
      // between any check and this write — a line that starts on its own never glues. Empty lines are skipped by readers.
      const at = fs.fstatSync(fd).size + 1;
      const room = PAGE - (at % PAGE);
      fs.writeSync(fd, `\n${Buffer.byteLength(line) > room ? '\n'.repeat(room) : ''}${line}`);
    } finally { fs.closeSync(fd); }
    try { db.exec('COMMIT'); } catch { /* the line is written; close() drops the lock — no error, no repeated event */ }
  } finally { db.close(); }
  return line;
}

const eventFiles = (memDir) => {
  const dir = path.join(memDir, 'events');
  try { return fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d\.jsonl$/.test(f)).sort(); } catch { return []; }
};

// All events in file order; a line that does not parse (torn, garbage) is skipped and named as file:line.
function readEvents(memDir) {
  const events = [], problems = [];
  for (const f of eventFiles(memDir)) {
    let text;
    try { text = fs.readFileSync(path.join(memDir, 'events', f), 'utf8'); } catch (e) { problems.push(`events/${f}: не читается — ${e.code || e.message}`); continue; }
    text.split('\n').forEach((l, i) => {
      if (!l.trim()) return;
      let ev = null;
      try { ev = JSON.parse(l); } catch { /* below */ }
      if (ev && typeof ev === 'object' && !Array.isArray(ev)) events.push(ev);
      else problems.push(`events/${f}:${i + 1}: рваная или битая строка — пропущена`);
    });
  }
  return { events, problems };
}

// lesson → {shown, repeat, merged, superseded, retired, last}: the counters a lesson file never holds.
function foldEvents(events) {
  const out = {};
  for (const e of events) {
    if (typeof e.lesson !== 'string') continue;
    const s = out[e.lesson] || (out[e.lesson] = { shown: 0, repeat: 0, merged: 0, superseded: 0, retired: 0, last: null });
    if (COUNTED.includes(e.kind)) s[e.kind]++;
    if (typeof e.at === 'string' && (!s.last || e.at > s.last)) s.last = e.at;
  }
  return out;
}

module.exports = { LOCK, appendEvent, readEvents, foldEvents, eventFiles, MAX_LINE, COUNTED };
