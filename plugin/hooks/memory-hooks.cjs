// Memory v2 in the hooks (slice 21): the library of the modules of the handler «memory» —
//   pretool.d/50-memory-bash-write   Bash never writes memory/lessons/** or decisions/** (deny with how to write one)
//   pretool.d/51-memory-repeat       a lesson already delivered in the epoch fires again → deny-once with its text
//   posttool.d/20-memory-write-check a lesson written by Write/Edit is validated at once (block with the problems)
//   posttool.d/21-memory-lessons     a lesson whose `when` fires on the finished call → delivered after it
//   stop.d/30-memory-commit          lesson events of the session → the project's memory/events; memory git under flock
//   sessionstart.d/40-memory-check   corrupt memory named in the brief (store.check), nothing blocked
// All of them act only in a hub project whose memory has lessons/ (memory v2); elsewhere they return null. The hot
// path (PreToolUse, PostToolUse) reads only memory/.triggers.json and the session's state of the delivery — no SQLite,
// no crypto. Places of a lesson in time (decision 05.11 on P10): right after the call that matched it, and before a
// repeat of it in the same epoch, once. Both need the delivery with memory (its «once per epoch»): without it the
// lesson modules are silent rather than repeating a lesson on every call.
'use strict';
const fs = require('fs');
const path = require('path');

const CAP = 4000; // characters of a field the triggers see: cmd/body/path from the head, out from the tail
const WHEN_FIELDS = ['tool', 'cmd', 'path', 'body', 'out'];
const MEMORY_DIRS = /^(lessons|decisions)(\/|$)/;

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
// A path that may not exist yet (a lesson being written): realpath of its nearest existing folder + the rest.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { /* go up */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  return path.resolve(p);
}

// projects/<name>/memory when it is memory v2 (has lessons/), else null: the modules are silent there.
function memoryOf(ctx) {
  if (!ctx || !ctx.project || !ctx.project.dir) return null;
  const dir = path.join(ctx.project.dir, 'memory');
  try { return fs.statSync(path.join(dir, 'lessons')).isDirectory() ? dir : null; } catch { return null; }
}

// memory/<rel> of an absolute or cwd-relative path inside the memory, or null.
function memoryRel(mem, file, cwd) {
  if (typeof file !== 'string' || !file) return null;
  const rel = path.relative(real(mem), realish(path.resolve(cwd || '/', file)));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
}

// ---------- triggers ----------

// A quantified group that itself holds a quantifier — `(a+)+`, `(?:\w+\s*)*` — backtracks exponentially on a long
// near-miss. The validator of 14 compiles `when` but cannot see this; the hot path skips such an item and the write
// check names it. Classes and escapes are skipped; `?` (optional, lazy) is no repetition.
function nestedQuantifier(src) {
  const stack = [{ q: false }];
  let inClass = false;
  const repeats = (s, i) => {
    if (s[i] === '+' || s[i] === '*') return true;
    const m = s[i] === '{' && /^\{(\d*)(,?)(\d*)\}/.exec(s.slice(i, i + 24));
    return Boolean(m) && (m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : Number(m[1])) >= 2;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { stack.push({ q: false }); continue; }
    if (c === ')') {
      const g = stack.length > 1 ? stack.pop() : { q: false };
      const rep = repeats(src, i + 1);
      if (rep && g.q) return true;
      if (rep || g.q) stack[stack.length - 1].q = true;
      continue;
    }
    if (repeats(src, i) && i > 0 && src[i - 1] !== '(') stack[stack.length - 1].q = true;
  }
  return false;
}

// One `when` item → {field: RegExp} or a reason it is not taken.
function compileItem(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return { error: 'не блок полей' };
  const out = {};
  const keys = Object.keys(w);
  if (!keys.length) return { error: 'пустой элемент' };
  for (const k of keys) {
    if (!WHEN_FIELDS.includes(k) || typeof w[k] !== 'string') return { error: `поле ${k}` };
    if (nestedQuantifier(w[k])) return { error: `${k}: вложенный повтор «${w[k].slice(0, 60)}» — экспоненциальный откат на длинном вводе` };
    try { out[k] = new RegExp(w[k], 'i'); } catch (e) { return { error: `${k}: ${e.message}` }; }
  }
  return { rx: out };
}

// Live lessons with a trigger, as the hot path uses them: [{id, first, core, items: [{field: RegExp}]}].
function loadTriggers(mem) {
  let t;
  try { t = JSON.parse(fs.readFileSync(path.join(mem, '.triggers.json'), 'utf8')); } catch { return []; }
  const out = [];
  for (const l of t && Array.isArray(t.lessons) ? t.lessons : []) {
    if (!l || typeof l.id !== 'string' || !Array.isArray(l.when)) continue;
    const items = l.when.map(compileItem).filter((c) => c.rx).map((c) => c.rx);
    if (items.length) out.push({ id: l.id, first: String(l.first || '').slice(0, 300), core: l.layer === 'core', items });
  }
  return out;
}

const head = (s) => String(s || '').slice(0, CAP);
const tail = (s) => String(s || '').slice(-CAP);
// The fields of a call the triggers are written against (as in the memory prototype): tool, cmd, path, body, out.
function fieldsOf(ev, { withOut = false } = {}) {
  const ti = (ev && ev.tool_input) || {};
  const tool = String((ev && ev.tool_name) || '');
  let body = '';
  if (typeof ti.content === 'string') body = ti.content;
  else if (typeof ti.new_string === 'string') body = ti.new_string;
  else if (Array.isArray(ti.edits)) body = ti.edits.map((e) => (e && typeof e.new_string === 'string' ? e.new_string : '')).join('\n');
  else if (typeof ti.new_source === 'string') body = ti.new_source;
  else if (tool !== 'Bash') { try { body = JSON.stringify(ti); } catch { body = ''; } }
  let out = '';
  if (withOut) {
    const r = ev.tool_response;
    out = (typeof r === 'string' ? r : r && typeof r === 'object' ? `${r.stdout || ''}\n${r.stderr || ''}` : '').replace(/\x1b\[[0-9;]*m/g, '');
  }
  return { tool, cmd: head(typeof ti.command === 'string' ? ti.command : ''), path: head(ti.file_path || ti.notebook_path || ti.path || ''),
    body: head(body), out: tail(out) };
}

// Lessons whose trigger fires on the fields: an item fires when every field it names is there and matches. Order — the
// core first, then the more specific item (more fields), then the id: the delivery keeps 3 per call in this order.
function match(triggers, f) {
  const hits = [];
  for (const t of triggers) {
    let best = 0;
    for (const it of t.items) {
      const ks = Object.keys(it);
      if (ks.every((k) => f[k] && it[k].test(f[k]))) best = Math.max(best, ks.length);
    }
    if (best) hits.push({ ...t, score: best });
  }
  return hits.sort((a, b) => (b.core - a.core) || (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const lessonText = (t) => `Урок памяти (${t.id}): ${t.first}`;
const lessonItem = (t) => ({ text: lessonText(t), priority: 'lesson', key: `lesson:${t.id}`, lesson: t.id, detector: `lesson:${t.id}`, source: 'memory' });

// The text of a lesson as data in a deny reason: the frame of the delivery (a reason is not framed by it).
function framed(text) {
  const { FRAME } = require('./lib/deliver.cjs');
  const mark = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${FRAME.open} · ${mark}; рамку закрывает только строка «/данные из памяти · ${mark}» в квадратных скобках]\n${text}\n${FRAME.close} · ${mark}]`;
}

// ---------- the modules ----------

// PostToolUse: the lessons the finished call matched. A write into the memory itself is no mistake to teach about.
function lessonsAfter(ev, ctx) {
  if (!ctx.delivery) return null;
  const mem = memoryOf(ctx);
  if (!mem) return null;
  const f = fieldsOf(ev, { withOut: true });
  if (f.path && memoryRel(mem, f.path, ev.cwd)) return null;
  const hits = match(loadTriggers(mem), f);
  return hits.length ? { items: hits.map(lessonItem) } : null;
}

// PreToolUse: a lesson already delivered to this agent in this epoch fires again — the same mistake is about to
// repeat: deny once (the delivery drops the next deny of the same key in the epoch and counts the repeat).
function repeatBefore(ev, ctx) {
  if (!ctx.delivery || !ev.session_id) return null;
  const mem = memoryOf(ctx);
  if (!mem) return null;
  const f = fieldsOf(ev);
  if (f.path && memoryRel(mem, f.path, ev.cwd)) return null;
  const hits = match(loadTriggers(mem), f);
  if (!hits.length) return null;
  const session = require('./lib/session.cjs');
  const a = session.read(ev.session_id).agents[session.agentOf(ev)];
  if (!a || a.epoch !== ctx.epoch || !a.shown) return null;
  const t = hits.find((h) => a.shown[`lesson:${h.id}`]);
  if (!t) return null;
  return { decision: 'deny', once: `lesson:${t.id}`, lesson: t.id, detector: `lesson:${t.id}`,
    reason: `Хаб: урок памяти «${t.id}» уже подан в этой эпохе, а вызов снова подходит под его признак — остановлен один раз.\n`
      + `${framed(lessonText(t))}\nЕсли урок здесь не к месту — повтори вызов как есть: второй раз он пройдёт.` };
}

// PostToolUse Write/Edit/MultiEdit of memory/lessons/*.md or memory/decisions/*.md: the validator of 14 on the file
// as it is now, plus the `when` items the hot path would skip; then .triggers.json follows the files at once.
function checkWrite(ev, ctx) {
  if (!['Write', 'Edit', 'MultiEdit'].includes(ev.tool_name)) return null;
  const mem = memoryOf(ctx);
  if (!mem) return null;
  const ti = ev.tool_input || {};
  const rel = memoryRel(mem, ti.file_path, ev.cwd);
  if (!rel || !/^(lessons|decisions)\/[^/]+\.md$/.test(rel) || path.basename(rel).startsWith('.')) return null;
  let buf;
  try { buf = fs.readFileSync(path.join(mem, rel)); } catch { return null; }
  const { validateLesson, parseLesson } = require('../lib/memory/format.cjs');
  const problems = validateLesson(buf, { file: `memory/${rel}` });
  if (!problems.length) {
    const { meta } = parseLesson(buf.toString('utf8'));
    (Array.isArray(meta.when) ? meta.when : []).forEach((w, i) => {
      const c = compileItem(w);
      if (c.error) problems.push(`when[${i}].${c.error}: хук его не возьмёт`);
    });
  }
  try { require('../lib/memory/store.cjs').ensureTriggers(mem); } catch { /* the next search rebuilds it */ }
  if (!problems.length) return null;
  return { decision: 'block', reason: `Хаб: урок memory/${rel} не прошёл проверку памяти:\n${problems.slice(0, 12).map((p) => `- ${p}`).join('\n')}\n`
    + 'Исправь файл (Edit/Write) — пока он с ошибкой, у урока нет триггера и подачи. Проверка всей памяти — recall check.' };
}

// ---------- Bash into the memory ----------

const WRITE_ALL = new Set(['tee', 'touch', 'truncate', 'rm', 'unlink', 'shred', 'mv']);
const WRITE_TARGET = new Set(['cp', 'install', 'ln', 'rsync']);
const INTERP = new Set(['node', 'nodejs', 'python', 'python3', 'perl', 'ruby', 'deno', 'bun', 'php']);
const CODE_FLAGS = /^-(?:e|c|p|E|r|pe|ne|pi|e[a-z]*)$|^--eval$|^--print$/;
const WRITE_API = /\b(?:writeFile|appendFile|createWriteStream|copyFile|rename|unlink|rmSync|rmdir|write_text|write_bytes|shutil\.(?:copy\w*|move)|os\.(?:remove|rename|replace|unlink))|\bopen\s*\([^)]*,\s*['"][^'"]*[wax+]/;
const REDIRECT = /(?:^|[^<>&\d])(?:\d+|&)?>{1,2}\|?\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;&|()<>"']+))/g;

// The first path of the memory's lessons/ or decisions/ the command writes, or null. Writes: a redirection, tee,
// touch/truncate/rm/mv/shred, the target of cp/install/ln/rsync, sed -i / perl -i, dd of=, and inline code of an
// interpreter (-e/-c, or a heredoc fed to it) that names such a path and calls a write API. Reads pass.
function bashWritesMemory(cmd, cwd, mem) {
  if (typeof cmd !== 'string' || !/lessons|decisions/.test(cmd)) return null;
  const { executions } = require('../skills/dispatch/scripts/shell.cjs');
  let execs = [];
  try { execs = executions(cmd, { cwd: cwd || '/' }).execs || []; } catch { execs = []; }
  const bases = [cwd || '/'];
  for (const e of execs) {
    const n = path.basename(String(e.argv[0] || ''));
    if ((n === 'cd' || n === 'pushd') && e.argv[1] && !e.argv[1].startsWith('-')) bases.push(path.resolve(cwd || '/', e.argv[1]));
  }
  const memReal = real(mem);
  const hit = (tok) => {
    if (typeof tok !== 'string' || !tok || tok.startsWith('-') || tok.includes('$')) return null;
    for (const b of bases) {
      const rel = path.relative(memReal, realish(path.resolve(b, tok)));
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && MEMORY_DIRS.test(rel.split(path.sep).join('/'))) return tok;
    }
    return null;
  };
  const codeHit = (code) => {
    if (!WRITE_API.test(code)) return null;
    for (const m of code.matchAll(/(['"`])((?:(?!\1)[^\n])*?(?:lessons|decisions)(?:(?!\1)[^\n])*?)\1/g)) { if (hit(m[2])) return m[2]; }
    return null;
  };
  for (const m of cmd.matchAll(REDIRECT)) { const t = hit(m[1] ?? m[2] ?? m[3]); if (t) return t; }
  for (const e of execs) {
    const a = e.argv.map(String);
    const n = path.basename(a[0] || '');
    const args = a.slice(1);
    const plain = args.filter((x) => !x.startsWith('-'));
    let t = null;
    if (WRITE_ALL.has(n)) t = plain.map(hit).find(Boolean);
    else if (WRITE_TARGET.has(n)) {
      const ti = args.findIndex((x) => x === '-t' || x === '--target-directory');
      const eq = args.find((x) => x.startsWith('--target-directory='));
      t = hit(ti >= 0 ? args[ti + 1] : eq ? eq.slice(eq.indexOf('=') + 1) : plain[plain.length - 1]);
    } else if ((n === 'sed' || n === 'perl') && args.some((x) => /^-[a-zA-Z]*i/.test(x) || x.startsWith('--in-place'))) t = plain.map(hit).find(Boolean);
    else if (n === 'dd') t = args.filter((x) => x.startsWith('of=')).map((x) => hit(x.slice(3))).find(Boolean);
    else if (INTERP.has(n)) {
      for (let i = 0; i < args.length && !t; i++) if (CODE_FLAGS.test(args[i]) && typeof args[i + 1] === 'string') t = codeHit(args[i + 1]);
    }
    if (t) return t;
  }
  // A heredoc body is data to the shell reader: code fed to an interpreter through it is judged by the text.
  if (/<<-?\s*['"]?\w+/.test(cmd) && execs.some((e) => INTERP.has(path.basename(String(e.argv[0] || ''))))) return codeHit(cmd);
  return null;
}

function bashWrite(ev, ctx) {
  if (ev.tool_name !== 'Bash') return null;
  const mem = memoryOf(ctx);
  if (!mem) return null;
  const target = bashWritesMemory((ev.tool_input || {}).command, ev.cwd, mem);
  if (!target) return null;
  return { decision: 'deny', reason: `Хаб: в memory/lessons/ и memory/decisions/ Bash не пишет (${target.slice(0, 120)}): такая запись обходит проверку урока. `
    + 'Урок — инструментом Write в memory/lessons/<id>.md (решение — memory/decisions/<id>.md), правка — Edit: хук сразу проверит файл '
    + 'валидатором памяти (формат, NUL, компиляция `when`, URL и команды отправки) и назовёт ошибки — регэксп `when` не надо проверять через node -e. '
    + 'Повтор, отставка, слияние, замена и проверка всей памяти — скилл recall (recall.cjs repeat | retire | merge | supersede | check). '
    + 'Эпизод в старый errors.md — строкой, как раньше.' };
}

// ---------- Stop: events of the session into the project, memory history ----------

const MIRROR = new Set(['shown', 'deny', 'block', 'ask', 'repeat', 'prevented', 'expired']);
const keyOf = (e) => [e.at, e.kind, e.lesson, e.tool_use_id || '', e.agent_id || ''].join('|');

// The delivery journals what it really showed (after limits and «already shown») into the hooks' data folder, for every
// project; the counters of a lesson (retirement, recall why) live in the project's memory/events. Stop copies the lesson
// lines of this session that the project does not have yet — once: a line is known by (at, kind, lesson, call, agent).
function mirrorEvents(ev, mem) {
  const sid = ev.session_id;
  if (!sid) return 0;
  const { files } = require('./lib/events.cjs');
  const now = new Date();
  const months = [now.toISOString().slice(0, 7)];
  if (now.getUTCDate() <= 2) months.push(new Date(now.getTime() - 3 * 864e5).toISOString().slice(0, 7));
  const needle = `"session_id":${JSON.stringify(String(sid))}`;
  const found = [];
  for (const f of files().filter((x) => months.includes(path.basename(x, '.jsonl')))) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l.includes(needle) || !l.includes('"lesson":')) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e && e.session_id === sid && typeof e.lesson === 'string' && MIRROR.has(e.kind)) found.push(e);
    }
  }
  if (!found.length) return 0;
  const mevents = require('../lib/memory/events.cjs');
  const have = new Set(mevents.readEvents(mem).events.filter((e) => e.session_id === sid).map(keyOf));
  let n = 0;
  for (const e of found) {
    if (have.has(keyOf(e))) continue;
    have.add(keyOf(e));
    try { mevents.appendEvent(mem, e); n++; } catch { /* a line the memory refuses (too long) is skipped */ }
  }
  return n;
}

// Commit lessons/, decisions/, events/ to the memory's own git under `flock -n` (P14): busy → skip till the next Stop,
// no change → no commit, no memory/.git → nothing (the git of memory is made by the template or the migration).
function commitMemory(mem, sid) {
  if (!fs.existsSync(path.join(mem, '.git'))) return 'no-git';
  const dirs = ['lessons', 'decisions', 'events'].filter((d) => fs.existsSync(path.join(mem, d)));
  if (!dirs.length) return 'nothing';
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)));
  Object.assign(env, { MSG: `memory: stop ${String(sid || '?').slice(0, 8)}`, GIT_AUTHOR_NAME: 'hub memory hook', GIT_AUTHOR_EMAIL: 'hub-memory@localhost',
    GIT_COMMITTER_NAME: 'hub memory hook', GIT_COMMITTER_EMAIL: 'hub-memory@localhost' });
  const script = 'git add -A -- "$@" && { git diff --cached --quiet -- "$@" && echo nothing || '
    + 'git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -q --no-verify -m "$MSG" -- "$@"; }';
  const { spawnSync } = require('child_process');
  const r = spawnSync('flock', ['-n', '-E', '75', path.join(mem, '.git', 'hub-memory.lock'), 'sh', '-c', script, 'sh', ...dirs],
    { cwd: mem, env, encoding: 'utf8', timeout: 8000 });
  if (r.error) return `error: ${r.error.code || r.error.message}`;
  if (r.status === 75) return 'busy';
  if (r.status !== 0) return `error: ${(r.stderr || '').trim().split('\n').pop() || r.status}`;
  return /nothing/.test(r.stdout) ? 'nothing' : 'committed';
}

function stop(ev, ctx) {
  const mem = memoryOf(ctx);
  if (!mem) return null;
  try { mirrorEvents(ev, mem); } catch (e) { require('./lib/journal.cjs').journal({ type: 'error', event: 'Stop', module: 'memory-commit', error: `mirror: ${e.message}`, policy: 'open' }); }
  const res = commitMemory(mem, ev.session_id);
  if (res.startsWith('error')) require('./lib/journal.cjs').journal({ type: 'error', event: 'Stop', module: 'memory-commit', error: res, policy: 'open' });
  return null;
}

// ---------- SessionStart: corruption named ----------

function preflight(ev, ctx) {
  const mem = memoryOf(ctx);
  if (!mem) return null;
  const { problems } = require('../lib/memory/store.cjs').check(mem);
  if (!problems.length) return null;
  const shown = problems.slice(0, 20).map((p) => `- ${p}`);
  if (problems.length > 20) shown.push(`- … ещё ${problems.length - 20} — recall check`);
  return { items: [{ text: `Память v2 проекта ${ctx.project.name}: проблем ${problems.length} — вызовы не блокируются, но урок с ошибкой не подаётся. `
    + `Исправь файлы (Edit/Write), проверка всей памяти — recall check:\n${shown.join('\n')}`, priority: 'reminder', key: 'memory-check', source: 'memory' }] };
}

module.exports = { memoryOf, memoryRel, nestedQuantifier, compileItem, loadTriggers, fieldsOf, match, lessonsAfter, repeatBefore,
  checkWrite, bashWritesMemory, bashWrite, mirrorEvents, commitMemory, stop, preflight, CAP };
