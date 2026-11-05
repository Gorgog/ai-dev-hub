#!/usr/bin/env node
// Real time of a task, measured from Claude Code session transcripts (~/.claude/projects/<folder>/<session>.jsonl).
// usage:
//   node session-time.cjs key <KEY> [--root <projects-dir>] [--marks <est-marks.jsonl>] [--index-only]
//                                                             all rounds marked «EST-START <KEY>» … «EST-END <KEY>»
//   node session-time.cjs dir <working-folder> [--root <dir>]  every session started in that folder (a worktree)
//   node session-time.cjs file <transcript.jsonl> [--key <KEY>]
// Every gap between two events goes to «active» (Claude, agents, tests running), to «wait» (the gap that ends
// with a human message or an answer to AskUserQuestion / ExitPlanMode: the user was answering — its first 20 min,
// the rest is a pause, the user was away) or to «pause» (20 min or more with no human message at its end:
// a permission prompt nobody answered, a night, a resumed session — not work). The markers count in Claude's own
// text and in the messages it sends (SendMessage / *send_message `message` — a session under the dispatcher puts
// «⏱ EST-START <KEY>» in its «принял бриф» there), in a message only on a line of its own. Other tool input does
// not count: a brief written with Write or start_session quotes the marker mid-sentence for the task session.
// A window without EST-END runs to the end of its transcript (ended: false).
// `key` takes the transcripts the scan finds together with those the index of marks names (the Stop hook keeps it:
// projects/<name>/memory/est-marks.jsonl of the working folder, or --marks; marks.cjs). The index is never trusted
// alone by default: a session before the canary, a mark out of the hook's tail, a killed turn leave it partial, and
// a hidden round is a fact too low. The output says how many sessions each side knew and how many the index missed;
// --index-only reads only the index (fast, may miss rounds).
// Next to active time the output shows it +20% (--buffer <pct>): a reserve for what transcripts do not see.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NOT_HUMAN = /^\s*<task-notification/;
const PAUSE_MS = 20 * 60000;
// Tools whose result is the user's answer, not work.
const ASKS_USER = new Set(['AskUserQuestion', 'ExitPlanMode']);
// Tools that send a message to another session: what Claude says there is its own text too.
const sends = (name) => name === 'SendMessage' || /(^|__)send_message$/.test(name || '');

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
    let sent = '';
    if (o.type === 'user' && !o.isMeta) {
      if (typeof content === 'string') human = !NOT_HUMAN.test(content);
      else human = (blocks.some((b) => b.type === 'text') && !blocks.some((b) => b.type === 'tool_result')) ||
        blocks.some((b) => b.type === 'tool_result' && asks.has(b.tool_use_id));
    }
    if (o.type === 'assistant') {
      text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      sent = blocks.filter((b) => b.type === 'tool_use' && sends(b.name) && b.input && typeof b.input.message === 'string')
        .map((b) => b.input.message).join('\n');
      for (const b of blocks) if (b.type === 'tool_use' && ASKS_USER.has(b.name)) asks.add(b.id);
    }
    events.push({ t: Date.parse(o.timestamp), id: o.uuid || `${o.timestamp}|${o.type}`, human, text, sent });
  }
  return events.sort((a, b) => a.t - b.t);
}

// Matches an event: anywhere in Claude's text, or at the start of a line (after «⏱», backticks) in a sent message.
function marker(word, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const said = new RegExp(`EST-${word}\\s+${k}(?![\\w-])`);
  const sent = new RegExp(`(^|\\n)[^\\S\\n]*\`?(⏱\\uFE0F?[^\\S\\n]*)?EST-${word}\\s+${k}(?![\\w-])`);
  return { test: (e) => said.test(e.text) || sent.test(e.sent || '') };
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
      if (!start.test(events[i])) continue;
      let j = i + 1;
      while (j < events.length && !end.test(events[j])) j++;
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

// Transcripts (root/<folder>/<session>.jsonl, not deeper: subagents) that mention the marker. grep reads the
// gigabytes of journals at disk speed in one process; reading each file into node took seconds and hundreds of MB.
// No grep or an error — every transcript, filtered in node.
function candidates(root, needle) {
  const all = () => fs.readdirSync(root).map((d) => path.join(root, d))
    .filter((dir) => fs.statSync(dir).isDirectory()).flatMap(transcripts);
  const g = spawnSync('grep', ['-rlF', '--include=*.jsonl', '--', needle, root],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  if (g.error || (g.status !== 0 && g.status !== 1)) return all().filter((f) => fs.readFileSync(f, 'utf8').includes(needle));
  const top = path.resolve(root);
  return g.stdout.split('\n').filter((f) => f && path.dirname(path.dirname(path.resolve(f))) === top);
}

function findByKey(root, key, { marks, indexOnly = false } = {}) {
  const indexed = (marks ? require('./marks.cjs').transcriptsFor(marks, key) : []).map((f) => path.resolve(f)).filter((f) => fs.existsSync(f));
  const scanned = indexOnly ? [] : candidates(root, `EST-START ${key}`).map((f) => path.resolve(f));
  const known = new Set(indexed);
  const unindexed = scanned.filter((f) => !known.has(f)).length;
  const source = indexOnly ? 'marks' : marks ? 'scan+marks' : 'scan';
  const rounds = [];
  for (const f of new Set([...indexed, ...scanned])) {
    const r = measure(parseFile(f), { key });
    if (r) rounds.push({ file: f, ...r });
  }
  rounds.sort((a, b) => a.start.localeCompare(b.start));
  return { rounds, total: total(rounds), source, indexed: indexed.length, scanned: scanned.length, unindexed };
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

// Active time with a reserve for what the transcripts do not see (setup, context switches, the user's own checks):
// printed next to the measured figure, never instead of it.
const BUFFER_PCT = 20;
const withBuffer = (min, pct = BUFFER_PCT) => Math.round(min * (1 + pct / 100));

function print(result, pct = BUFFER_PCT) {
  const plus = (min) => `+${pct}% ${withBuffer(min, pct)} min`;
  for (const r of result.rounds) {
    console.log(`${r.start.slice(0, 16)} → ${r.end.slice(11, 16)}  active ${r.activeMin} min  ${plus(r.activeMin)}  ` +
      `wait ${r.waitMin} min  pause ${r.pauseMin} min  human ${r.humanMessages}${r.ended ? '' : '  (no EST-END)'}  ` +
      `${path.basename(r.file)}`);
  }
  const t = result.total;
  console.log(`TOTAL  active ${t.activeMin} min  ${plus(t.activeMin)}  wait ${t.waitMin} min  pause ${t.pauseMin} min  ` +
    `human ${t.humanMessages}  rounds ${result.rounds.length}`);
  const s = result.source;
  if (s === 'marks') console.log(`source: marks only (index of the Stop hook, --index-only: ${result.indexed} transcripts; may miss rounds)`);
  else if (s === 'scan+marks') console.log(`source: scan + marks: ${result.indexed} in the index, ${result.scanned} found by the scan, ${result.unindexed} not in the index`);
  else if (s === 'scan') console.log('source: scan (every transcript)');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const root = opt('--root') || path.join(os.homedir(), '.claude', 'projects');
  const key = opt('--key');
  const indexOnly = args.includes('--index-only') && !!args.splice(args.indexOf('--index-only'), 1);
  const marks = opt('--marks') || require('./marks.cjs').marksFileFor(process.cwd());
  const die = (m) => { process.stderr.write(m + '\n'); process.exit(1); };
  const pct = Number(opt('--buffer') ?? BUFFER_PCT);
  if (!Number.isFinite(pct) || pct < 0) die('--buffer: a percentage, e.g. 20');
  const [cmd, arg] = args;
  if (cmd === 'key' && arg) print(findByKey(root, arg, { marks, indexOnly }), pct);
  else if (cmd === 'dir' && arg) print(byDir(root, arg), pct);
  else if (cmd === 'file' && arg) {
    const r = measure(parseFile(arg), { key });
    if (!r) die(`no EST-START ${key} in ${arg}`);
    print({ rounds: [{ file: arg, ...r }], total: total([r]) }, pct);
  } else die('usage: session-time.cjs key <KEY> | dir <working-folder> | file <transcript.jsonl> [--key KEY]  [--root <dir>]  [--marks <file>] [--index-only]  [--buffer 20]');
}

module.exports = { parseFile, measure, slugFor, findByKey, byDir, candidates, withBuffer, BUFFER_PCT };
