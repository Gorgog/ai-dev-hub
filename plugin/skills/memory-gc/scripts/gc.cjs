#!/usr/bin/env node
// gc — memory-gc over memory v2 of a hub project (skill `memory-gc`); the library is plugin/lib/memory/.
//   gc.cjs [--memory <dir>] dups                    pairs of live lessons that are each other's nearest (merge candidates)
//   gc.cjs retire [--days N] [--now YYYY-MM-DD]     rules not shown nor repeated for N days (default 30) — proposals
//   gc.cjs review --model <id> | review --list      after a model change: mark every live lesson for review (events)
//   gc.cjs reviewed <id> [--note <текст>]           the lesson was looked at under the new model
// Reports change nothing: merge and retire are `recall merge|retire` after the user's «да». Only review/reviewed
// append events. A project without memory/lessons/ has no v2 memory: said so, code 0. Codes: 0 done, 1 refused, 2 usage.
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../../../lib/memory/store.cjs');
const { appendEvent, readEvents } = require('../../../lib/memory/events.cjs');
const { parseLesson } = require('../../../lib/memory/format.cjs');

const USAGE = 'команды: dups · retire [--days N] · review --model <id> · review --list · reviewed <id> [--note <текст>]';
const LIVE = ['core', 'active'];
const REVIEW = ['review', 'reviewed'];

function parse(argv) {
  const a = { _: [], memory: null, days: 30, now: null, model: null, list: false, note: undefined };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--memory') a.memory = argv[++i];
    else if (k === '--days') a.days = Math.max(1, Number(argv[++i]) || 30);
    else if (k === '--now') a.now = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--list') a.list = true;
    else if (k === '--note') a.note = argv[++i];
    else a._.push(k);
  }
  return a;
}

function where(a) {
  const dir = a.memory || process.env.HUB_MEMORY_DIR;
  if (dir) return { dir: path.resolve(dir), newFormat: fs.existsSync(path.join(path.resolve(dir), 'lessons')) };
  return S.memoryDir(process.cwd());
}

const session = () => process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || undefined;

// Live lessons (not decisions): id and parsed meta.
function liveLessons(mem) {
  let names = [];
  try { names = fs.readdirSync(path.join(mem, 'lessons')).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort(); } catch { return []; }
  return names.map((f) => {
    const file = path.join(mem, 'lessons', f);
    const { meta, body } = parseLesson(fs.readFileSync(file, 'utf8').replace(/\u0000/g, ''));
    const words = new Set(S.terms([...(Array.isArray(meta.keys) ? meta.keys : []), ...body].join(' ')));
    return { id: f.slice(0, -3), file, words, status: meta.status || 'active' };
  }).filter((l) => LIVE.includes(l.status));
}

// Shared words of two lessons over all their words: two texts of one thing share ≥ 0.3 (measured on the fixtures:
// one thing 0.44, unrelated lessons with the same filler line ≤ 0.27, without it ≤ 0.08).
const MIN_OVERLAP = 0.3;
const overlap = (x, y) => [...x].filter((t) => y.has(t)).length / Math.max(1, new Set([...x, ...y]).size);

// Mutual nearest neighbours (A's top similar is B and B's is A) that share enough words: in a small memory any two
// lessons are each other's nearest. A proposal list, the agent and the user decide.
function dups(mem) {
  const live = liveLessons(mem);
  const ids = new Set(live.map((l) => l.id));
  const top = new Map();
  for (const l of live) {
    const hit = S.similar(mem, l.file, { top: 3 }).hits.find((h) => ids.has(h.id) && h.dir === 'lessons');
    if (hit) top.set(l.id, hit);
  }
  const pairs = [];
  for (const [a, h] of top) {
    const back = top.get(h.id);
    if (!back || back.id !== a || a > h.id) continue;
    const j = overlap(live.find((l) => l.id === a).words, live.find((l) => l.id === h.id).words);
    if (j >= MIN_OVERLAP) pairs.push([a, h.id, j]);
  }
  if (!pairs.length) return 'дублей нет: ни у одной пары уроков ближайший сосед не взаимный';
  return ['Кандидаты на слияние (взаимно ближайшие; решает пользователь, слияние — Edit приёмника + `recall merge`):',
    ...pairs.map(([x, y, j]) => `- ${x} ↔ ${y} (общих слов ${Math.round(j * 100)} %)`)].join('\n');
}

function retire(mem, a) {
  const now = a.now ? new Date(`${a.now}T23:59:59.999Z`) : new Date();
  if (Number.isNaN(now.getTime())) throw Object.assign(new Error(`--now ${a.now}: нужна дата ГГГГ-ММ-ДД`), { code: 2 });
  const ids = S.retirementCandidates(mem, { days: a.days, now });
  if (!ids.length) return `кандидатов в отставку нет (правила без показа и повтора ${a.days} дн.)`;
  return [`Кандидаты в отставку — правила без показа и повтора ${a.days} дн. (класс «одного раза» и ядро не уходят; `
    + 'после «да» — `recall retire <id> --note …`):', ...ids.map((id) => `- ${id}`)].join('\n');
}

// The model of the newest event that names one — the model the lessons were last seen under.
function lastModel(events) {
  let best = null;
  for (const e of events) {
    if (REVIEW.includes(e.kind) || typeof e.model !== 'string' || !e.model) continue;
    if (!best || String(e.at) >= String(best.at)) best = e;
  }
  return best ? best.model : null;
}

// Per lesson, the newest review-family event: `review` — waits for a look, `reviewed` — done.
function reviewState(events) {
  const st = {};
  for (const e of events) {
    if (!REVIEW.includes(e.kind) || typeof e.lesson !== 'string') continue;
    const cur = st[e.lesson];
    if (!cur || String(e.at) >= String(cur.at)) st[e.lesson] = e;
  }
  return st;
}

function review(mem, a) {
  const { events } = readEvents(mem);
  const live = liveLessons(mem);
  const st = reviewState(events);
  if (a.list) {
    const wait = live.filter((l) => st[l.id] && st[l.id].kind === 'review');
    if (!wait.length) return 'на пересмотре уроков нет';
    return ['На пересмотре (после смены модели; посмотрел — `gc.cjs reviewed <id>`, устарел — `recall retire`):',
      ...wait.map((l) => `- ${l.id} (${st[l.id].note || st[l.id].model})`)].join('\n');
  }
  if (!a.model) throw Object.assign(new Error(`review: нужна --model <id> или --list\n${USAGE}`), { code: 2 });
  const prev = lastModel(events);
  if (!prev) return 'модель прошлых событий неизвестна (в событиях нет поля model) — пересмотр не нужен';
  if (prev === a.model) return `модель не менялась (${prev}) — пересмотр не нужен`;
  const note = `смена модели ${prev} → ${a.model}`;
  // Idempotent: a lesson already marked (or reviewed) under this model is not marked again.
  const todo = live.filter((l) => !(st[l.id] && st[l.id].model === a.model));
  for (const l of todo) appendEvent(mem, { kind: 'review', lesson: l.id, session_id: session(), model: a.model, mode: 'memory-gc', note });
  return `${note}: на пересмотр поставлено ${todo.length} из ${live.length} живых уроков (список — review --list)`;
}

function reviewed(mem, id, a) {
  const { events } = readEvents(mem);
  const why = S.why(mem, id); // throws for an unknown id
  const st = reviewState(events)[id];
  appendEvent(mem, { kind: 'reviewed', lesson: why.id, session_id: session(), model: st ? st.model : undefined, mode: 'memory-gc',
    ...(a.note !== undefined ? { note: a.note } : {}) });
  return `${id}: пересмотрен`;
}

function main(argv) {
  const a = parse(argv);
  const [cmd, ...rest] = a._;
  if (!['dups', 'retire', 'review', 'reviewed'].includes(cmd)) {
    throw Object.assign(new Error(cmd ? `неизвестная команда ${cmd}\n${USAGE}` : USAGE), { code: 2 });
  }
  const m = where(a);
  if (!m) throw Object.assign(new Error('не в проекте хаба (projects/<имя>/…): укажи --memory <папка memory>'), { code: 2 });
  if (!m.newFormat) return 'памяти нового формата нет: в проекте нет memory/lessons/ — уборка по шагам старого формата (errors-index.md, errors.md)';
  switch (cmd) {
    case 'dups': return dups(m.dir);
    case 'retire': return retire(m.dir, a);
    case 'review': return review(m.dir, a);
    default:
      if (!rest[0]) throw Object.assign(new Error(`reviewed: нужен id\n${USAGE}`), { code: 2 });
      return reviewed(m.dir, rest[0], a);
  }
}

if (require.main === module) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (e) {
    process.stderr.write(`gc: ${e.message}\n`);
    process.exitCode = e.code === 2 ? 2 : 1;
  }
}

module.exports = { main };
