#!/usr/bin/env node
// Real time of a task, measured from Claude Code session transcripts (~/.claude/projects/<folder>/<session>.jsonl).
// usage:
//   node session-time.cjs key <KEY> [--root <projects-dir>]   all rounds marked «EST-START <KEY>» … «EST-END <KEY>»
//   node session-time.cjs dir <working-folder> [--root <dir>]  every session started in that folder (a worktree)
//   node session-time.cjs file <transcript.jsonl> [--key <KEY>]
// Every gap between two events goes to «active» (Claude, agents, tests running), to «wait» (the gap that ends
// with a human message or an answer to AskUserQuestion / ExitPlanMode: the user was answering — its first 20 min,
// the rest is a pause, the user was away) or to «pause» (20 min or more with no human message at its end:
// a permission prompt nobody answered, a night, a resumed session — not work). The markers count only in Claude's
// own text, not in tool input.
// A window without EST-END runs to the end of its transcript (ended: false).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOT_HUMAN = /^\s*<task-notification/;
const PAUSE_MS = 20 * 60000;
// Tools whose result is the user's answer, not work.
const ASKS_USER = new Set(['AskUserQuestion', 'ExitPlanMode']);

function parseFile(file) {
  const events = [];
  const asks = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || !o.timestamp || o.isSidechain) continue;
    const content = o.message && o.message.content;
    const blocks = Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [];
    let human = false;
    let text = '';
    if (o.type === 'user' && !o.isMeta) {
      if (typeof content === 'string') human = !NOT_HUMAN.test(content);
      else human = (blocks.some((b) => b.type === 'text') && !blocks.some((b) => b.type === 'tool_result')) ||
        blocks.some((b) => b.type === 'tool_result' && asks.has(b.tool_use_id));
    }
    if (o.type === 'assistant') {
      text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      for (const b of blocks) if (b.type === 'tool_use' && ASKS_USER.has(b.name)) asks.add(b.id);
    }
    events.push({ t: Date.parse(o.timestamp), id: o.uuid || `${o.timestamp}|${o.type}`, human, text });
  }
  return events.sort((a, b) => a.t - b.t);
}

function marker(word, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`EST-${word}\\s+${k}(?![\\w-])`);
}

// A gap is named by its two events: a forked transcript repeats the history with the same ids, so the same gap
// found in two files is counted once. A human-ended gap longer than PAUSE_MS splits into a wait and a pause.
function gapsOf(events) {
  const gaps = [];
  for (let i = 1; i < events.length; i++) {
    const ms = events[i].t - events[i - 1].t;
    const id = `${events[i - 1].id}>${events[i].id}`;
    if (events[i].human) {
      gaps.push({ id, ms: Math.min(ms, PAUSE_MS), kind: 'wait' });
      if (ms > PAUSE_MS) gaps.push({ id: `${id}#away`, ms: ms - PAUSE_MS, kind: 'pause' });
    } else gaps.push({ id, ms, kind: ms >= PAUSE_MS ? 'pause' : 'active' });
  }
  return gaps;
}

const round = (ms) => Math.round(ms / 60000);

function sumGaps(gaps) {
  const unique = new Map(gaps.map((g) => [g.id, g]));
  const s = { active: 0, wait: 0, pause: 0, humanMessages: 0 };
  for (const g of unique.values()) {
    s[g.kind] += g.ms;
    if (g.kind === 'wait') s.humanMessages++;
  }
  return { activeMin: round(s.active), waitMin: round(s.wait), pauseMin: round(s.pause), humanMessages: s.humanMessages };
}

// null when the key has no EST-START in this transcript.
function measure(events, { key } = {}) {
  if (!events.length) return null;
  let windows = [{ from: 0, to: events.length - 1, ended: true }];
  if (key) {
    const start = marker('START', key), end = marker('END', key);
    windows = [];
    for (let i = 0; i < events.length; i++) {
      if (!start.test(events[i].text)) continue;
      let j = i + 1;
      while (j < events.length && !end.test(events[j].text)) j++;
      windows.push(j < events.length ? { from: i, to: j, ended: true } : { from: i, to: events.length - 1, ended: false });
      i = j;
    }
    if (!windows.length) return null;
  }
  const gaps = windows.flatMap((w) => gapsOf(events.slice(w.from, w.to + 1)));
  return {
    start: new Date(events[windows[0].from].t).toISOString(),
    end: new Date(events[windows[windows.length - 1].to].t).toISOString(),
    ...sumGaps(gaps),
    ended: windows.every((w) => w.ended),
    gaps,
  };
}

function transcripts(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
}

function total(rounds) {
  return sumGaps(rounds.flatMap((r) => r.gaps));
}

function findByKey(root, key) {
  const rounds = [];
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of transcripts(dir)) {
      if (!fs.readFileSync(f, 'utf8').includes(`EST-START ${key}`)) continue;
      const r = measure(parseFile(f), { key });
      if (r) rounds.push({ file: f, ...r });
    }
  }
  rounds.sort((a, b) => a.start.localeCompare(b.start));
  return { rounds, total: total(rounds) };
}

// The folder name Claude Code gives a working directory: every non-alphanumeric character becomes «-».
function slugFor(workdir) {
  return path.resolve(workdir).replace(/[^A-Za-z0-9]/g, '-');
}

function byDir(root, workdir) {
  const rounds = transcripts(path.join(root, slugFor(workdir)))
    .map((f) => { const r = measure(parseFile(f)); return r && { file: f, ...r }; })
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start));
  return { rounds, total: total(rounds) };
}

function print(result) {
  for (const r of result.rounds) {
    console.log(`${r.start.slice(0, 16)} → ${r.end.slice(11, 16)}  active ${r.activeMin} min  wait ${r.waitMin} min  ` +
      `pause ${r.pauseMin} min  human ${r.humanMessages}${r.ended ? '' : '  (no EST-END)'}  ${path.basename(r.file)}`);
  }
  const t = result.total;
  console.log(`TOTAL  active ${t.activeMin} min  wait ${t.waitMin} min  pause ${t.pauseMin} min  human ${t.humanMessages}  ` +
    `rounds ${result.rounds.length}`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const root = opt('--root') || path.join(os.homedir(), '.claude', 'projects');
  const key = opt('--key');
  const [cmd, arg] = args;
  const die = (m) => { process.stderr.write(m + '\n'); process.exit(1); };
  if (cmd === 'key' && arg) print(findByKey(root, arg));
  else if (cmd === 'dir' && arg) print(byDir(root, arg));
  else if (cmd === 'file' && arg) {
    const r = measure(parseFile(arg), { key });
    if (!r) die(`no EST-START ${key} in ${arg}`);
    print({ rounds: [{ file: arg, ...r }], total: total([r]) });
  } else die('usage: session-time.cjs key <KEY> | dir <working-folder> | file <transcript.jsonl> [--key KEY]  [--root <dir>]');
}

module.exports = { parseFile, measure, slugFor, findByKey, byDir };
