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

// One write. A torn tail left by a killed writer (no final newline) is closed first, inside the same write, so the
// new line never glues onto the fragment.
function appendEvent(memDir, ev) {
  const { line, month } = eventLine(ev);
  const dir = path.join(memDir, 'events');
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, `${month}.jsonl`), 'a+');
  try {
    let buf = Buffer.from(line);
    const size = fs.fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) buf = Buffer.concat([Buffer.from('\n'), buf]);
    }
    fs.writeSync(fd, buf);
  } finally { fs.closeSync(fd); }
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

module.exports = { appendEvent, readEvents, foldEvents, eventFiles, MAX_LINE, COUNTED };
