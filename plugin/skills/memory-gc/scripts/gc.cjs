#!/usr/bin/env node
// gc — memory-gc over memory v2 of a hub project (skill `memory-gc`); the library is plugin/lib/memory/.
//   gc.cjs [--memory <dir>] dups                    pairs of live lessons that are each other's nearest (merge candidates)
//   gc.cjs retire [--days N] [--now YYYY-MM-DD]     rules not shown nor repeated for N days (default 30) — proposals
//   gc.cjs review --model <id> | review --list      after a model change: mark every live lesson for review (events);
//                                                   no review mark yet — the call writes the baseline
//   gc.cjs reviewed <id> [--note <текст>]           the lesson was looked at under the new model
//   gc.cjs fold [--months 3] [--now YYYY-MM-DD] [--apply]   event months older than N: one shown per lesson
//   gc.cjs core [--plugin <dir>]                    core lessons with a working trigger (decision г) — proposals
//   gc.cjs core --apply <id>… [--note <текст>]       those named candidates go core → active (after the user's «да»)
//   gc.cjs core --keep <id>… --note <почему>         the user keeps them in the core: not proposed until edited
// Reports change nothing: merge and retire are `recall merge|retire` after the user's «да». Only review/reviewed
// append events (core --keep too), only core --apply moves named lessons out of the core, only fold --apply rewrites old event months (the source kept in events/archive/). A project without memory/lessons/ has no v2 memory: said so, code 0. Codes: 0 done, 1 refused, 2 usage.
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../../../lib/memory/store.cjs');
const { appendEvent, readEvents, eventFiles, withEventsLock } = require('../../../lib/memory/events.cjs');
const { parseLesson } = require('../../../lib/memory/format.cjs');

const USAGE = 'команды: dups · retire [--days N] · review --model <id> · review --list · reviewed <id> [--note <текст>] · '
  + 'fold [--months 3] [--apply] · core [--apply | --keep <id>… --note <текст>]';
const LIVE = ['core', 'active'];
const REVIEW = ['review', 'reviewed'];

function parse(argv) {
  const a = { _: [], memory: null, days: 30, months: 3, now: null, model: null, list: false, note: undefined, apply: false, keep: false, plugin: undefined };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--memory') a.memory = argv[++i];
    else if (k === '--days') a.days = Math.max(1, Number(argv[++i]) || 30);
    else if (k === '--months') a.months = Math.max(1, Number(argv[++i]) || 3);
    else if (k === '--apply') a.apply = true;
    else if (k === '--keep') a.keep = true;
    else if (k === '--now') a.now = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--list') a.list = true;
    else if (k === '--note') a.note = argv[++i];
    else if (k === '--plugin') a.plugin = path.resolve(argv[++i] || '.');
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
    return { id: f.slice(0, -3), file, words: wordsOf(meta, body), status: meta.status || 'active' };
  }).filter((l) => LIVE.includes(l.status));
}

// Shared words of two lessons over all their words: two texts of one thing share ≥ 0.3 (measured on the fixtures:
// one thing 0.44, unrelated lessons with the same filler line ≤ 0.27, without it ≤ 0.08).
// Also wind-down's «is this draft a repeat» check (episode.cjs) — one measure for both.
const MIN_OVERLAP = 0.3;
const wordsOf = (meta, body) => new Set(S.terms([...(Array.isArray(meta.keys) ? meta.keys : []), ...body].join(' ')));
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

// The core by decision (г) 06.11: a core lesson whose trigger the lesson hook really sees belongs in active — the hook
// delivers it at the moment of the mistake, the brief's 15 core lines are for what no hook can deliver. Class «once»
// and a trigger only on calls the hook does not listen to stay. --apply moves only named current candidates, all or
// nothing (one id that is not a candidate — nothing moves).
function core(mem, a, named) {
  const ids = [...new Set(named)];
  let hook;
  try { hook = S.lessonHookTools(a.plugin); } catch (e) { throw Object.assign(e, { code: 1 }); }
  const opts = a.plugin ? { plugin: a.plugin } : {};
  const cands = S.coreCandidates(mem, opts);
  const on = `хук уроков слушает ${hook.event}: ${hook.tools.join('|')}`;
  if (a.apply && a.keep) throw Object.assign(new Error(`core: --apply или --keep, не оба\n${USAGE}`), { code: 2 });
  if (a.apply || a.keep) {
    const flag = a.apply ? '--apply' : '--keep';
    if (!ids.length) throw Object.assign(new Error(`core ${flag}: назови id кандидатов\n${USAGE}`), { code: 2 });
    const known = new Set(cands.map((c) => c.id));
    const bad = ids.filter((id) => !known.has(id));
    if (bad.length) {
      throw Object.assign(new Error(`не кандидаты на вынос из ядра (решение (г)): ${bad.join(', ')} — ничего не записано; `
        + 'кандидаты — `gc.cjs core`'), { code: 1 });
    }
    const who = { session_id: session(), note: a.note };
    if (a.keep) {
      for (const id of ids) S.keepInCore(mem, id, who);
      return [`Оставлены в ядре (событие kept-core; снова предложит, только если урок правили):`, ...ids.map((id) => `- ${id}`)].join('\n');
    }
    for (const id of ids) S.toActive(mem, id, who);
    return [`Из ядра в active (${on}):`, ...ids.map((id) => `- ${id}`)].join('\n');
  }
  const inCore = S.fold(mem).entries.filter((e) => e.dir === 'lessons' && e.status === 'core').length;
  const kept = new Set(readEvents(mem).events.filter((e) => e.kind === 'kept-core').map((e) => e.lesson)).size;
  if (!cands.length) {
    return `кандидатов нет: в ядре ${inCore}, у уроков ядра нет триггера, который видит хук (${on})`
      + `${kept ? `; оставлены в ядре решением (kept-core): ${kept}` : ''}`;
  }
  return [`Кандидаты на вынос из ядра в active — триггер видит хук (${on}); в ядре ${inCore}. Класс «одного раза» и уроки `
    + 'без такого триггера остаются. После «да» — `gc.cjs core --apply <id>… --note "<почему>"`; оставить в ядре — '
    + '`gc.cjs core --keep <id>… --note "<почему>"`:',
  ...cands.map((c) => `- ${c.id}: ${c.reason}`)].join('\n');
}

// Per lesson, the newest review-family event: `review` — waits for a look, `reviewed` — done.
function reviewState(events) {
  const st = {};
  for (const e of events) {
    // A mark without a model (reviewed before any review) says nothing about the model: it does not count.
    if (!REVIEW.includes(e.kind) || typeof e.lesson !== 'string' || typeof e.model !== 'string' || !e.model) continue;
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
  // The model each lesson was last looked at under: its own review mark, else the newest mark of any lesson (a lesson
  // written after it). Only review marks count — a wind-down repeat under the new model must not hide the change.
  const marks = Object.values(st);
  if (!marks.length) {
    // No review mark yet. Any other model the events already carry (wind-down `--model`, delivery) means the lessons
    // were seen under it — a change, even if a newer event is under this model (a needless review is cheaper than a
    // missed one). Otherwise this call is the baseline (decision 05.11): `reviewed` with the model on every live
    // lesson; from then on only review marks count.
    const prev = newestModel(events.filter((e) => e.model !== a.model));
    if (prev) return mark(mem, live, () => prev, a.model);
    for (const l of live) {
      appendEvent(mem, { kind: 'reviewed', lesson: l.id, session_id: session(), model: a.model, mode: 'memory-gc', note: 'опорная модель' });
    }
    return newestModel(events) ? `модель не менялась (${a.model}) — пересмотр не нужен; опорная отметка записана`
      : `опорная модель ${a.model} записана для ${live.length} живых уроков — пересмотр не нужен; смена модели будет видна`;
  }
  const newest = marks.reduce((x, y) => (String(y.at) >= String(x.at) ? y : x)).model;
  const ref = (l) => (st[l.id] ? st[l.id].model : newest);
  if (!live.some((l) => ref(l) !== a.model)) return `модель не менялась (${a.model}) — пересмотр не нужен`;
  return mark(mem, live, ref, a.model);
}

function mark(mem, live, ref, model) {
  const todo = live.filter((l) => ref(l) !== model);
  const from = [...new Set(todo.map(ref))].join(', ');
  for (const l of todo) {
    appendEvent(mem, { kind: 'review', lesson: l.id, session_id: session(), model, mode: 'memory-gc', note: `смена модели ${ref(l)} → ${model}` });
  }
  return `смена модели ${from} → ${model}: на пересмотр поставлено ${todo.length} из ${live.length} живых уроков (список — review --list)`;
}

// The model of the newest event that names one — wind-down `--model`, delivery; the reference before any review mark.
function newestModel(events) {
  let best = null;
  for (const e of events) if (typeof e.model === 'string' && e.model && (!best || String(e.at) >= String(best.at))) best = e;
  return best ? best.model : null;
}

function reviewed(mem, id, a) {
  const { events } = readEvents(mem);
  const why = S.why(mem, id); // throws for an unknown id
  const st = reviewState(events)[id];
  appendEvent(mem, { kind: 'reviewed', lesson: why.id, session_id: session(), model: st ? st.model : a.model || undefined, mode: 'memory-gc',
    ...(a.note !== undefined ? { note: a.note } : {}) });
  return `${id}: пересмотрен`;
}

// Fold of old event months (decision 05.11, without a library change): in a month older than `months` every event
// stays except `shown` — of those only the last per lesson (or rule). So repeats, merges, retirements and `last` stay
// exact; `shown` of a folded month means «was shown in that month», not how often (delivery effect — by the delivery
// log, not by folded memory events). The month as it was goes to events/archive/<ГГГГ-ММ>.jsonl byte for byte (the
// reader does not see it); an archive already there is never overwritten — lines of the month it lacks (a crash
// between the two writes, a late writer) are appended to it first. Lines are kept as written, in their order. A shown
// with no lesson/rule or no `at` is not folded: there is nothing to tell which one is the last.
function foldMonth(text) {
  const rows = [];
  let broken = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let e = null;
    try { e = JSON.parse(l); } catch { /* below */ }
    if (e && typeof e === 'object' && !Array.isArray(e)) rows.push({ l, e }); else broken++;
  }
  const lastShown = new Map();
  rows.forEach((r, i) => {
    if (r.e.kind !== 'shown' || typeof r.e.at !== 'string') return;
    const key = typeof r.e.lesson === 'string' ? `l:${r.e.lesson}` : typeof r.e.rule === 'string' ? `r:${r.e.rule}` : null;
    if (!key) return;
    const cur = lastShown.get(key);
    if (cur === undefined || String(r.e.at) >= String(rows[cur].e.at)) lastShown.set(key, i);
  });
  const keep = new Set(lastShown.values());
  const folded = (r) => r.e.kind === 'shown' && typeof r.e.at === 'string' && (typeof r.e.lesson === 'string' || typeof r.e.rule === 'string');
  const kept = rows.filter((r, i) => !folded(r) || keep.has(i)).map((r) => r.l);
  return { total: rows.length + broken, kept, broken };
}

const writeVia = (file, data) => {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};

function foldOne(dir, f, month, a, out, locked) {
  const file = path.join(dir, f);
  const fd = fs.openSync(file, 'r');
  try {
    const src = fs.readFileSync(fd);
    const r = foldMonth(src.toString('utf8'));
    if (!r.broken && r.kept.length === r.total) return; // at most one shown per lesson already
    const arch = path.join(dir, 'archive', f);
    const had = fs.existsSync(arch) ? fs.readFileSync(arch, 'utf8') : null;
    const inArch = new Set(had === null ? [] : had.split('\n'));
    const missing = had === null ? [] : src.toString('utf8').split('\n').filter((l) => l.trim() && !inArch.has(l));
    const line = `${month}: событий ${r.total} → ${r.kept.length}${r.broken ? ` (битых строк ${r.broken} — только в архиве)` : ''}`
      + (had === null ? '' : ` (архив уже был — дописано строк ${missing.length})`);
    if (!a.apply) { out.push(line); return; }
    // The source first: a crash between the two writes leaves the month whole, and the next run finishes it.
    if (had === null) {
      fs.mkdirSync(path.dirname(arch), { recursive: true });
      writeVia(arch, src);
    } else if (missing.length) {
      writeVia(arch, `${had}${had && !had.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    }
    writeVia(file, r.kept.length ? `${r.kept.join('\n')}\n` : '');
    // Lines the old inode got after the read (a framed writer): into the new month and into the archive, each on a line
    // of its own — the archive stays «the month as it was» (review 1: a later fold may have nothing to fold and never
    // reach the «missing» lines above).
    const size = fs.fstatSync(fd).size;
    let late = '';
    if (size > src.length) {
      const extra = Buffer.alloc(size - src.length);
      fs.readSync(fd, extra, 0, extra.length, src.length);
      late = ` (во время свёртки дописано ${extra.toString('utf8').split('\n').filter((l) => l.trim()).length} строк — перенесены)`;
      fs.appendFileSync(file, Buffer.concat([Buffer.from('\n'), extra]));
      fs.appendFileSync(arch, Buffer.concat([Buffer.from('\n'), extra]));
    }
    out.push(`${line}${late}${locked ? '' : ' (без замка событий)'}`);
  } finally { fs.closeSync(fd); }
}

function fold(mem, a) {
  const now = a.now ? new Date(`${a.now}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(now.getTime())) throw Object.assign(new Error(`--now ${a.now}: нужна дата ГГГГ-ММ-ДД`), { code: 2 });
  const edge = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - a.months, 1)).toISOString().slice(0, 7);
  const dir = path.join(mem, 'events');
  const out = [];
  for (const f of eventFiles(mem)) {
    const month = f.slice(0, 7);
    if (month >= edge) continue;
    // --apply rewrites the month under the events lock (slice 32): a locked writer waits, it does not append into the
    // inode being replaced. A writer without the lock (the \n frame) may still have the old inode open: what that inode
    // got after the read is carried into the new month (fd kept open over the rename).
    const step = (locked) => foldOne(dir, f, month, a, out, locked);
    if (a.apply) withEventsLock(mem, step); else step(false);
  }
  if (!out.length) return `сворачивать нечего: в месяцах до ${edge} по одному показу на урок`;
  return [a.apply ? 'Свёрнуто (исходники — events/archive/; shown свёрнутого месяца = «был показан в месяце»):'
    : 'Свернуть можно (после «да» — fold --apply; shown свёрнутого месяца = «был показан в месяце»):', ...out.map((l) => `- ${l}`)].join('\n');
}

function main(argv) {
  const a = parse(argv);
  const [cmd, ...rest] = a._;
  if (!['dups', 'retire', 'review', 'reviewed', 'fold', 'core'].includes(cmd)) {
    throw Object.assign(new Error(cmd ? `неизвестная команда ${cmd}\n${USAGE}` : USAGE), { code: 2 });
  }
  const m = where(a);
  if (!m) throw Object.assign(new Error('не в проекте хаба (projects/<имя>/…): укажи --memory <папка memory>'), { code: 2 });
  if (!m.newFormat) return 'памяти нового формата нет: в проекте нет memory/lessons/ — уборка по шагам старого формата (errors-index.md, errors.md)';
  switch (cmd) {
    case 'dups': return dups(m.dir);
    case 'retire': return retire(m.dir, a);
    case 'review': return review(m.dir, a);
    case 'fold': return fold(m.dir, a);
    case 'core': return core(m.dir, a, rest);
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

module.exports = { main, overlap, wordsOf, MIN_OVERLAP };
