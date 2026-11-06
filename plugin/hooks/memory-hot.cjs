// Memory v2 in the hooks (slice 21), the hot path: what every PreToolUse / PostToolUse of a memory-v2 project runs —
// where the memory is, the triggers of memory/.triggers.json, the matcher, and the two lesson modules (memory-lessons
// after a call, memory-repeat before a repeat). Kept apart from memory-hooks.cjs (the write check, Bash into the
// memory, Stop, SessionStart) because a hook call is a cold process: loading the whole library cost ≈ 4 ms per call.
'use strict';
const fs = require('fs');
const path = require('path');

const CAP = 4000; // characters of a field the triggers see: cmd/body/path from the head, out from the tail
const WHEN_FIELDS = ['tool', 'cmd', 'path', 'body', 'out'];

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

// A `when` source that may backtrack catastrophically on a long field, or null — a warning only (decision 05.11,
// variant D): the hot path runs every source as written under the vm watchdog (matchGuarded), the write check and
// SessionStart name these forms so the author can narrow them. A repeated group holding a repetition or an
// alternation, three repeated atoms in a row, three unbounded repetitions of a wide atom (`.`, `[^…]`, `\S`, `[\s\S]`).
const ADJACENT = /(?:(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\\()[\]|^$])(?:[*+]|\{\d+,\d*\})\??){3,}/;
const WIDE = /(?:\.|\[\^(?:\\.|[^\]\\])*\]|\\[SWD]|\[\\s\\S\]|\[\\S\\s\])(?:[*+]|\{\d+,\})/g;
function whenProblem(src) {
  const bad = nestedQuantifier(src) ? 'повтор группы, внутри которой повтор'
    : /\((?:\?:)?[^()]*\|[^()]*\)(?:[*+]|\{\d+,|\{\d{2,}\})/.test(src) ? 'повтор группы с альтернативой'
      : ADJACENT.test(src) ? 'три повтора подряд'
        : (src.match(WIDE) || []).length >= 3 ? 'три широких неограниченных повтора'
          : null;
  return bad ? `«${src.slice(0, 60)}»: ${bad} — на длинном вводе возможен долгий откат (сторож прервёт, урок уйдёт в карантин); лучше сузить` : null;
}

// One `when` item → {rx: {field: RegExp}, warn: [..]} or {error}: the write hook blocks on an error (an unknown field,
// a regex that does not compile) and only names a warning.
function compileItem(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return { error: 'не блок полей' };
  const out = {}, warn = [];
  const keys = Object.keys(w);
  if (!keys.length) return { error: 'пустой элемент' };
  for (const k of keys) {
    if (!WHEN_FIELDS.includes(k) || typeof w[k] !== 'string') return { error: `поле ${k}` };
    try { out[k] = new RegExp(w[k], 'i'); } catch (e) { return { error: `${k}: регэксп не компилируется — ${e.message}` }; }
    const why = whenProblem(w[k]);
    if (why) warn.push(`${k}: ${why}`);
  }
  return { rx: out, warn };
}

// The longest run of characters every match must contain, lower case ('' — none known): a cheap `includes` before the
// regex, so a cold hook process compiles only the regexes whose literal is in the call (V8 compiles a regex on its
// first run; 250 lessons are ≈ 670 of them). Conservative: only top-level atoms count — a top-level `|` gives none,
// groups and classes break a run, a character made optional or repeated by `?`, `*`, `{` leaves it.
function literalOf(src, { raw = false } = {}) {
  let best = '', cur = '', depth = 0, inClass = false;
  const quant = (j) => src[j] === '{' && /^\{\d+(?:,\d*)?\}/.test(src.slice(j, j + 24));
  const flush = () => { if (cur.length > best.length) best = cur; cur = ''; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inClass) { if (c === '\\') i++; else if (c === ']') inClass = false; continue; }
    if (c === '[') { flush(); inClass = true; continue; }
    if (c === '(') { flush(); depth++; continue; }
    if (c === ')') { flush(); depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) { if (c === '\\') i++; continue; }
    if (c === '|') return '';
    if (c === '\\') {
      const n = src[i + 1] || '';
      i++;
      if (/[A-Za-z0-9]/.test(n)) {
        // Only a well-formed escape is stepped over; an incomplete \x, \u, \c is a plain letter without the u flag —
        // the run just breaks there, and whatever follows (a top-level `|` too) is read as usual.
        flush();
        if (n === 'x' && /^[0-9a-fA-F]{2}/.test(src.slice(i + 1, i + 3))) i += 2;
        else if (n === 'u' && /^[0-9a-fA-F]{4}/.test(src.slice(i + 1, i + 5))) i += 4;
        else if (n === 'c' && /^[A-Za-z]/.test(src[i + 1] || '')) i += 1;
        else if (n === 'k' && src[i + 1] === '<' && src.indexOf('>', i) > i) i = src.indexOf('>', i);
        continue;
      }
      cur += n;
    } else if (c === '?' || c === '*' || quant(i)) {
      cur = cur.slice(0, -1);
      flush();
      if (c === '{') i = src.indexOf('}', i);
      continue;
    } else if (c === '+' || c === '^' || c === '$' || c === '.') { flush(); continue; }
    else cur += c; // a `{` that is no quantifier is a literal brace
    const nx = src[i + 1];
    if (nx === '?' || nx === '*' || quant(i + 1)) { cur = cur.slice(0, -1); flush(); }
  }
  flush();
  if (raw) return best.length >= 2 ? best : ''; // as written: the caller folds it the way the field is folded
  const lit = best.toLowerCase();
  // A letter whose case folding differs from toLowerCase (ς, µ) could make `includes` miss what `i` matches.
  return lit.length >= 2 && [...lit].every((ch) => ch.toUpperCase().toLowerCase() === ch) ? lit : '';
}

// What the hot path knows of a regex source, computed on first use and shared by every item with that source: its
// literal (for the `includes` before the regex) and the compiled regex (`i`, as written; one that does not compile
// never matches).
// The prefilter folds both sides exactly as the `i` flag without `u` compares characters (ECMAScript Canonicalize: a
// character is its toUpperCase when that is one character and does not take a non-ASCII character to ASCII): ς and σ,
// µ and μ, ϑ and θ share a capital, toLowerCase of the field would keep them apart and drop a real match.
const canon = (ch) => { const u = ch.toUpperCase(); return u.length !== 1 || (ch.charCodeAt(0) >= 128 && u.charCodeAt(0) < 128) ? ch : u; };
function foldText(s) {
  if (!/[^\x00-\x7f]/.test(s)) return s.toUpperCase();
  let out = '';
  for (const ch of s) out += ch.length === 1 ? canon(ch) : ch;
  return out;
}
const srcCache = new Map();
function condOf(src) {
  let c = srcCache.get(src);
  if (!c) { c = { lit: foldText(literalOf(src, { raw: true })), re: undefined }; srcCache.set(src, c); }
  return c;
}
function rxOf(src, c = condOf(src)) {
  if (c.re === undefined) { try { c.re = new RegExp(src, 'i'); } catch { c.re = null; } }
  return c.re;
}

// The quarantine of sources the watchdog cut twice (memory/.triggers-quarantine.json, {key: {lesson, field, src, at}});
// the key is a hash of the source, so editing the lesson's `when` lifts it. FNV-1a: an identity, not a secret.
const QUARANTINE = '.triggers-quarantine.json';
const keyOf = (src) => {
  let h = 0x811c9dc5;
  for (const ch of String(src)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${String(src).length}.${h.toString(16)}`;
};
function readFile(mem) {
  try { const q = JSON.parse(fs.readFileSync(path.join(mem, QUARANTINE), 'utf8')); return q && typeof q === 'object' && !Array.isArray(q) ? q : {}; } catch { return {}; }
}
// The quarantined sources ({key: entry}); `_suspects` — sources that were the slowest of a cut run, counted.
const readQuarantine = (mem) => Object.fromEntries(Object.entries(readFile(mem)).filter(([k]) => !k.startsWith('_')));
// entry → the quarantine at once; suspect → its count goes up, the second time it is quarantined too.
function quarantine(mem, entry, { suspect = false } = {}) {
  try {
    const q = readFile(mem);
    const key = keyOf(entry.src);
    if (suspect) {
      const sus = q._suspects && typeof q._suspects === 'object' ? q._suspects : {};
      sus[key] = (Number(sus[key]) || 0) + 1;
      q._suspects = sus;
      if (sus[key] < 2) { entry = null; } else delete sus[key];
    }
    if (entry) q[key] = { ...entry, src: String(entry.src).slice(0, 300), at: new Date().toISOString() };
    const file = path.join(mem, QUARANTINE);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(q, null, 1)}\n`);
    fs.renameSync(tmp, file);
  } catch { /* the journal still has it; the next timeout tries again */ }
}

// Live lessons with a trigger, as the hot path uses them: [{id, first, core, when: [{field: source}]}] — the file as it
// is, nothing compiled: match() looks at a condition only when the call gets to it. A hook call is one process and
// reads the file once; a process that serves many calls (a replay) reuses it while its size and mtime stay the same.
const cache = new Map();
function loadTriggers(mem) {
  const file = path.join(mem, '.triggers.json');
  let t, sig;
  try {
    const st = fs.statSync(file, { bigint: true });
    sig = `${st.size}:${st.mtimeNs}:${st.ino}`;
    if (cache.has(file) && cache.get(file).sig === sig) return cache.get(file).list;
    t = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return []; }
  const out = [];
  for (const l of t && Array.isArray(t.lessons) ? t.lessons : []) {
    if (l && typeof l.id === 'string' && Array.isArray(l.when) && l.when.length) {
      out.push({ id: l.id, first: String(l.first || '').slice(0, 300), core: l.layer === 'core', when: l.when });
    }
  }
  cache.set(file, { sig, list: out });
  return out;
}

const head = (s) => String(s || '').slice(0, CAP);
const tail = (s) => String(s || '').slice(-CAP);
// The text an MCP tool or an agent returned (slice 35): its content blocks of type text — as an array, an object with
// content or a string; images and other blocks are not text. An agent that handed its report back (SubagentHandback)
// has a stub in content and the report in handbackReport.text (review 06.11: so are all sync agents of the hub). Only
// for these tools: the out of the tools seen before (Bash, Edit, Write, …) stays byte for byte what it was.
const CONTENT_OUT = /^(?:Agent|Task|mcp__.+)$/;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c)
  ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
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
    const report = r && typeof r === 'object' && r.handbackReport && typeof r.handbackReport.text === 'string' ? r.handbackReport.text : null;
    out = (CONTENT_OUT.test(tool) ? (report !== null ? report : r && typeof r === 'object' && !Array.isArray(r) ? textOf(r.content) : textOf(r))
      : typeof r === 'string' ? r : r && typeof r === 'object' ? `${r.stdout || ''}\n${r.stderr || ''}` : '').replace(/\x1b\[[0-9;]*m/g, '');
  }
  return { tool, cmd: head(typeof ti.command === 'string' ? ti.command : ''), path: head(ti.file_path || ti.notebook_path || ti.path || ''),
    body: head(body), out: tail(out) };
}

// Lessons whose trigger fires on the fields: an item fires when every field it names is there and matches. Order — the
// core first, then the more specific item (more fields), then the id: the delivery keeps 3 per call in this order.
// opts.skip — quarantined keys; opts.state — where the condition being tested is noted (state.cur) for the watchdog.
function match(triggers, f, { skip = null, state = null } = {}) {
  const hits = [];
  const folded = {};
  const fold = (k) => (folded[k] ??= foldText(f[k]));
  const holds = (k, src, id) => {
    if (typeof src !== 'string' || !WHEN_FIELDS.includes(k) || !f[k]) return false;
    if (skip && skip.has(keyOf(src))) return false;
    const c = condOf(src);
    if (c.lit && !fold(k).includes(c.lit)) return false;
    if (state) state.cur = { lesson: id, field: k, src };
    const t0 = state ? process.hrtime.bigint() : 0n;
    const re = rxOf(src, c);
    const hit = Boolean(re) && re.test(f[k]);
    if (state) state.times.set(src, (state.times.get(src) || 0) + Number(process.hrtime.bigint() - t0) / 1e6);
    return hit;
  };
  // An item fires when every field it names holds; `tool` is tried first (few sources, most items stop there).
  const fires = (w, id) => {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return 0;
    if ('tool' in w && !holds('tool', w.tool, id)) return 0;
    let n = 0;
    for (const k in w) { if (k !== 'tool' && !holds(k, w[k], id)) return 0; n++; }
    return n;
  };
  for (const t of triggers) {
    let best = 0;
    for (const w of t.when) { const n = fires(w, t.id); if (n > best) best = n; }
    if (best) hits.push({ ...t, score: best });
  }
  return hits.sort((a, b) => (b.core - a.core) || (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The watchdog (decision 05.11, variant D): the whole match runs as one synchronous vm script with a timeout — a regex
// backtracking without end is interrupted inside irregexp, the process stays healthy and the other modules of the call
// keep their decisions. A run cut by the timeout loses this call's lessons (fail-open); the condition it was in is
// journaled and rechecked alone under RECHECK_MS — cut again, it goes to the quarantine. Must stay synchronous: the
// timeout covers only synchronous work. Context and script — once per process.
const BUDGET_MS = 50, RECHECK_MS = 30;
let guard = null;
function guarded(fn, ms) {
  if (!guard) {
    const vm = require('vm');
    const state = { job: null, out: null, cur: null, times: new Map() };
    guard = { state, ctx: vm.createContext({ all: () => { state.out = state.job(); } }), script: new vm.Script('all()') };
  }
  guard.state.job = fn;
  guard.state.out = null;
  guard.state.cur = null;
  guard.state.times = new Map();
  try { guard.script.runInContext(guard.ctx, { timeout: ms }); return { ok: true, out: guard.state.out }; } catch (e) {
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { ok: false };
    throw e;
  }
}
function matchGuarded(triggers, f, mem) {
  const q = readQuarantine(mem);
  const skip = new Set(Object.keys(q));
  const run = guarded(() => match(triggers, f, { skip, state: guard.state }), BUDGET_MS);
  if (run.ok) return run.out;
  const cur = guard.state.cur || {};
  const times = guard.state.times;
  const again = cur.src ? guarded(() => rxOf(cur.src).test(f[cur.field]), RECHECK_MS) : { ok: true };
  if (!again.ok) quarantine(mem, { lesson: cur.lesson, field: cur.field, src: cur.src });
  else {
    // No single culprit: the budget went to several conditions. The slowest of the run (the cut one counted with the
    // rest of the budget) is a suspect; a suspect twice goes to the quarantine.
    if (cur.src) times.set(cur.src, (times.get(cur.src) || 0) + BUDGET_MS);
    let worst = null;
    for (const [src, ms] of times) if (!worst || ms > worst.ms) worst = { src, ms };
    const who = worst && triggers.find((t) => t.when.some((w) => w && Object.values(w).includes(worst.src)));
    const field = who && Object.entries(who.when.find((w) => w && Object.values(w).includes(worst.src))).find(([, v]) => v === worst.src)[0];
    if (worst && worst.src) quarantine(mem, { lesson: who ? who.id : cur.lesson, field, src: worst.src }, { suspect: true });
  }
  require('./lib/journal.cjs').journal({ type: 'error', module: 'memory-hot.cjs', error: `when: сторож прервал сопоставление за ${BUDGET_MS} мс`,
    lesson: cur.lesson, field: cur.field, src: String(cur.src || '').slice(0, 200), quarantined: !again.ok, policy: 'open' });
  return [];
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
  const hits = matchGuarded(loadTriggers(mem), f, mem);
  return hits.length ? { items: hits.map(lessonItem) } : null;
}

// PreToolUse: a lesson already delivered to this agent in this epoch fires again — the same mistake is about to
// repeat: deny once (the delivery drops the next deny of the same key in the epoch and counts the repeat).
function repeatBefore(ev, ctx) {
  if (!ctx.delivery || !ev.session_id) return null;
  const mem = memoryOf(ctx);
  if (!mem) return null;
  // Only lessons already delivered to this agent in this epoch can be repeated: the state first (the delivery has
  // read it in this process already), the triggers of those lessons only.
  const session = require('./lib/session.cjs');
  const a = session.read(ev.session_id).agents[session.agentOf(ev)];
  if (!a || a.epoch !== ctx.epoch || !a.shown) return null;
  const shown = new Set(Object.keys(a.shown).filter((k) => k.startsWith('lesson:')).map((k) => k.slice(7)));
  if (!shown.size) return null;
  const f = fieldsOf(ev);
  if (f.path && memoryRel(mem, f.path, ev.cwd)) return null;
  const t = matchGuarded(loadTriggers(mem).filter((l) => shown.has(l.id)), f, mem)[0];
  if (!t) return null;
  return { decision: 'deny', once: `lesson:${t.id}`, lesson: t.id, detector: `lesson:${t.id}`,
    reason: `Хаб: урок памяти «${t.id}» уже подан в этой эпохе, а вызов снова подходит под его признак — остановлен один раз.\n`
      + `${framed(lessonText(t))}\nЕсли урок здесь не к месту — повтори вызов как есть: второй раз он пройдёт.` };
}

module.exports = { memoryOf, memoryRel, realish, real, nestedQuantifier, whenProblem, compileItem, literalOf, loadTriggers, fieldsOf, match,
  matchGuarded, readQuarantine, keyOf, lessonsAfter, repeatBefore, CAP, WHEN_FIELDS, QUARANTINE };
