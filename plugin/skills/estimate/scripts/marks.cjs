// Marks of the estimate «⏱ EST-START <KEY>» / «⏱ EST-END <KEY>» and their index — one line per (session, kind, key)
// in projects/<name>/memory/est-marks.jsonl: {at, key, kind, session_id, transcript_path, cwd}. The Stop module
// (plugin/hooks/stop.d/20-estimate-marks.cjs) writes it from the tail of the transcript and the last message;
// session-time.cjs `key` reads it and goes straight to the transcripts of the task instead of scanning them all.
// A mark counts anywhere in Claude's own text, in a message it sends (SendMessage / *send_message) only on a line of
// its own: a brief quotes the marker mid-sentence for the task session. Tool input and subagents do not count.
'use strict';
const fs = require('fs');
const path = require('path');

// A key starts and ends on a letter or digit: «EST-END K-1.» is K-1, «EST-START <KEY>» in a template is nothing.
const KEY = '[A-Za-z0-9](?:[\\w.-]*[A-Za-z0-9])?';
const SAID = new RegExp(`EST-(START|END)\\s+(${KEY})(?![\\w-])`, 'g');
const SENT = new RegExp(`(?:^|\\n)[^\\S\\n]*\`?(?:⏱\\uFE0F?[^\\S\\n]*)?EST-(START|END)\\s+(${KEY})(?![\\w-])`, 'g');
const sends = (name) => name === 'SendMessage' || /(^|__)send_message$/.test(name || '');

function found(text, sent) {
  const out = [];
  for (const [re, s] of [[SAID, text], [SENT, sent]]) {
    for (const m of String(s || '').matchAll(re)) out.push({ kind: m[1], key: m[2] });
  }
  return out;
}

// Marks of Claude's records in a transcript (not the human, not a subagent's sidechain).
function fromRecords(records) {
  const out = [];
  for (const o of records) {
    if (!o || o.type !== 'assistant' || o.isSidechain) continue;
    const content = o.message && o.message.content;
    const blocks = Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [];
    const text = typeof content === 'string' ? content : blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const sent = blocks.filter((b) => b.type === 'tool_use' && sends(b.name) && b.input && typeof b.input.message === 'string')
      .map((b) => b.input.message).join('\n');
    out.push(...found(text, sent));
  }
  return out;
}

// Records of the last `bytes` of a transcript, whole lines only; a missing or unreadable file — none. A turn rarely
// writes a megabyte, and a mark of a turn whose Stop never came (a killed session) is still in the next one's tail.
const TAIL = 1024 * 1024;
function tailRecords(file, bytes = TAIL) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let s = buf.toString('utf8');
    if (len < size) s = s.slice(s.indexOf('\n') + 1);
    if (!s.includes('EST-')) return [];
    const out = [];
    for (const line of s.split('\n')) {
      if (!line.includes('EST-')) continue;
      try { out.push(JSON.parse(line)); } catch { /* a line cut by a writer */ }
    }
    return out;
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readMarks(file) {
  let s;
  try { s = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of s.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && o.key && o.kind) out.push(o); } catch { /* skip */ }
  }
  return out;
}

// Appends the marks not yet in the index for this session; one appendFileSync — a short line, whole even under kill.
// Returns the number of lines written.
function record(file, marks, { session_id, transcript_path, cwd }) {
  if (!marks.length) return 0;
  const seen = new Set(readMarks(file).filter((m) => m.session_id === session_id).map((m) => `${m.kind} ${m.key}`));
  const at = new Date().toISOString();
  const lines = [];
  for (const { kind, key } of marks) {
    const id = `${kind} ${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push(JSON.stringify({ at, key, kind, session_id, transcript_path, cwd }));
  }
  if (!lines.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.join('\n') + '\n');
  return lines.length;
}

// Transcripts the index names for a key, in order of first mark.
function transcriptsFor(file, key) {
  return [...new Set(readMarks(file).filter((m) => m.key === key && m.transcript_path).map((m) => m.transcript_path))];
}

// projects/<name>/memory/est-marks.jsonl of the hub project a working folder is in, or null outside the hub's
// projects: found from the hub root (hooks/lib/hub.cjs), not by the shape of the path.
function marksFileFor(cwd, hub) {
  const { findProject, HUB_ROOT } = require('../../../hooks/lib/hub.cjs');
  const proj = findProject(cwd, hub || HUB_ROOT);
  return proj ? path.join(proj.dir, 'memory', 'est-marks.jsonl') : null;
}

module.exports = { found, fromRecords, tailRecords, record, readMarks, transcriptsFor, marksFileFor, TAIL };
