// Memory v2 in the hooks (slice 21), the hot path: what every PreToolUse / PostToolUse of a memory-v2 project runs —
// where the memory is, the triggers of memory/.triggers.json, the matcher, and the two lesson modules (memory-lessons
// after a call, memory-repeat before a repeat). Kept apart from memory-hooks.cjs (the write check, Bash into the
// memory, Stop, SessionStart) because a hook call is a cold process: loading the whole library cost ≈ 4 ms per call.
'use strict';
const fs = require('fs');
const path = require('path');

const CAP = 4000; // characters of a field the triggers see: cmd/body/path from the head, out from the tail
const WHEN_FIELDS = ['tool', 'cmd', 'path', 'body', 'out'];

// The guard against a `when` that backtracks catastrophically has two layers (review 05.11, rounds 1–2). First, static:
// whenProblem refuses the forms that blow up — a repeated group holding a repetition or an alternation (bounded
// `{1,30}` too), three repeated atoms in a row, and with lookaround or a backreference three unbounded repetitions at
// all. Second, V8's own: after 10 000 backtracks it reruns a regex on its linear engine — which takes no `i` flag, no
// lookaround, no backreference and no large bounded repetition, so it only adds to the static check. To give it the
// most triggers, a source whose meaning survives it runs case-folded by hand (lowerPattern on a lower-cased field);
// any other runs with `i` as written.
try {
  const v8 = require('v8');
  v8.setFlagsFromString('--enable-experimental-regexp-engine-on-excessive-backtracks');
  v8.setFlagsFromString('--regexp-backtracks-before-fallback=10000');
} catch { /* an older node: the static check still holds */ }

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

// Why a `when` source is not used by the hot path, or null (see the guard above). Always refused: a repeated group
// holding a repetition or an alternation (the linear engine takes no large bounded repetition either). For a source the
// linear engine cannot take (lookaround, a backreference, or one that runs with `i`), also: three repeated atoms in a
// row, three unbounded repetitions of a wide atom (`.`, `[^…]`, `\S`, `\W`, `\D`, `[\s\S]`) — polynomial backtracking.
const LINEAR_UNSUPPORTED = /\\[1-9]|\\k<|\(\?<?[=!]/;
const ADJACENT = /(?:(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\\()[\]|^$])(?:[*+]|\{\d+,\d*\})\??){3,}/;
const WIDE = /(?:\.|\[\^(?:\\.|[^\]\\])*\]|\\[SWD]|\[\\s\\S\]|\[\\S\\s\])(?:[*+]|\{\d+,\})/g;
function whenProblem(src) {
  try { new RegExp(src, 'i'); } catch (e) { return `регэксп не компилируется — ${e.message}`; }
  const noLinear = LINEAR_UNSUPPORTED.test(src) || lowerPattern(src) === null;
  const bad = nestedQuantifier(src) ? 'повтор группы, внутри которой повтор'
    : /\((?:\?:)?[^()]*\|[^()]*\)(?:[*+]|\{\d+,|\{\d{2,}\})/.test(src) ? 'повтор группы с альтернативой'
      : noLinear && ADJACENT.test(src) ? 'три повтора подряд при просмотре, обратной ссылке или флаге i'
        : noLinear && (src.match(WIDE) || []).length >= 3 ? 'три широких неограниченных повтора при просмотре, обратной ссылке или флаге i'
          : null;
  return bad ? `«${src.slice(0, 60)}»: ${bad} — откат без предела на длинном вводе, хук его не берёт` : null;
}

// One `when` item → {rx: {field: RegExp}} or {error}: the check the write hook names (syntax, nested repetition).
function compileItem(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return { error: 'не блок полей' };
  const out = {};
  const keys = Object.keys(w);
  if (!keys.length) return { error: 'пустой элемент' };
  for (const k of keys) {
    if (!WHEN_FIELDS.includes(k) || typeof w[k] !== 'string') return { error: `поле ${k}` };
    const why = whenProblem(w[k]);
    if (why) return { error: `${k}: ${why}` };
    out[k] = new RegExp(w[k], 'i');
  }
  return { rx: out };
}

// The longest run of characters every match must contain, lower case ('' — none known): a cheap `includes` before the
// regex, so a cold hook process compiles only the regexes whose literal is in the call (V8 compiles a regex on its
// first run; 250 lessons are ≈ 670 of them). Conservative: only top-level atoms count — a top-level `|` gives none,
// groups and classes break a run, a character made optional or repeated by `?`, `*`, `{` leaves it.
function literalOf(src) {
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
  const lit = best.toLowerCase();
  // A letter whose case folding differs from toLowerCase (ς, µ) could make `includes` miss what `i` matches.
  return lit.length >= 2 && [...lit].every((ch) => ch.toUpperCase().toLowerCase() === ch) ? lit : '';
}

// What the hot path knows of a regex source, computed on first use and shared by every item with that source: the
// literal, whether it is safe (no nested repetition — such a condition never matches) and the compiled regex (only
// past the literal; a source that does not compile never matches).
// The source with its literal letters through toLowerCase, for a lower-cased field and no `i`; null — lowering would
// change its meaning, so it runs with `i` as written: an escaped letter that is not a known escape (`\Z` is a plain Z
// without the u flag), a class range unless both ends are letters of one case (`[A-z]`, `[Z-a]`, `[\x00-\x5A]` cover
// other characters). Escapes stay as written (\S, \B); a well-formed \xHH or \uHHHH outside a class is re-escaped as
// its lower-case letter. Left: letters whose case folding differs from toLowerCase (σ/ς, µ/μ) — literalOf drops them.
const KNOWN_ESC = /[dDwWsSbBnrtfv0-9cxukpP]/;
const cased = (ch) => ch.toLowerCase() !== ch.toUpperCase();
function lowerPattern(src) {
  let out = '', inClass = false;
  const endAt = (i) => { // a class range end at i: [char, next index] or null
    if (src[i] !== '\\') return src[i] === undefined || src[i] === ']' ? null : [src[i], i + 1];
    const n = src[i + 1] || '';
    const hex = n === 'x' ? src.slice(i + 2, i + 4) : n === 'u' ? src.slice(i + 2, i + 6) : '';
    if (hex && /^[0-9a-fA-F]+$/.test(hex) && hex.length === (n === 'x' ? 2 : 4)) return [String.fromCharCode(parseInt(hex, 16)), i + 2 + hex.length];
    return /[A-Za-z0-9]/.test(n) ? null : [n, i + 2];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inClass) {
      if (c === ']') { inClass = false; out += c; continue; }
      const lo = endAt(i);
      if (lo && src[lo[1]] === '-' && src[lo[1] + 1] !== ']' && src[lo[1] + 1] !== undefined) {
        const hi = endAt(lo[1] + 1);
        if (!hi) return null;
        const [a, b] = [lo[0], hi[0]];
        const sameCase = cased(a) && cased(b) && (a === a.toLowerCase()) === (b === b.toLowerCase());
        if (!sameCase) {
          for (let cp = a.charCodeAt(0); cp <= b.charCodeAt(0); cp++) if (cased(String.fromCharCode(cp))) return null;
        }
        out += src.slice(i, hi[1]).toLowerCase() === src.slice(i, hi[1]) || !sameCase ? src.slice(i, hi[1]) : `${a.toLowerCase()}-${b.toLowerCase()}`;
        i = hi[1] - 1;
        continue;
      }
      if (c === '\\') {
        const n = src[i + 1] || '';
        if (/[A-Za-z]/.test(n) && !KNOWN_ESC.test(n)) return null;
        out += c + n; i++; continue;
      }
      out += c.toLowerCase();
      continue;
    }
    if (c === '[') { inClass = true; out += c; if (src[i + 1] === '^') { out += '^'; i++; } continue; }
    if (c !== '\\') { out += c.toLowerCase(); continue; }
    const n = src[i + 1] || '';
    const hex = n === 'x' ? src.slice(i + 2, i + 4) : n === 'u' ? src.slice(i + 2, i + 6) : '';
    if (hex && /^[0-9a-fA-F]+$/.test(hex) && hex.length === (n === 'x' ? 2 : 4)) {
      const ch = String.fromCharCode(parseInt(hex, 16)).toLowerCase();
      out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      i += 1 + hex.length;
    } else if (/[A-Za-z]/.test(n) && !KNOWN_ESC.test(n)) return null;
    else { out += c + n; i++; }
  }
  return out;
}

const srcCache = new Map();
function condOf(src) {
  let c = srcCache.get(src);
  if (!c) { const pat = lowerPattern(src); c = { pat, lit: literalOf(pat === null ? src : pat), re: undefined }; srcCache.set(src, c); }
  return c;
}
function rxOf(src, c = condOf(src)) {
  if (c.re === undefined) {
    c.re = null;
    if (!whenProblem(src)) { try { c.re = c.pat === null ? new RegExp(src, 'i') : new RegExp(c.pat); } catch { c.re = null; } }
  }
  return c.re;
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
  const low = {};
  const lower = (k) => (low[k] ??= f[k].toLowerCase());
  const holds = (k, src) => {
    if (typeof src !== 'string' || !WHEN_FIELDS.includes(k) || !f[k]) return false;
    const c = condOf(src);
    if (c.lit && !lower(k).includes(c.lit)) return false;
    const re = rxOf(src, c);
    return Boolean(re) && re.test(c.pat === null ? f[k] : lower(k));
  };
  // An item fires when every field it names holds; `tool` is tried first (few sources, most items stop there).
  const fires = (w) => {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return 0;
    if ('tool' in w && !holds('tool', w.tool)) return 0;
    let n = 0;
    for (const k in w) { if (k !== 'tool' && !holds(k, w[k])) return 0; n++; }
    return n;
  };
  for (const t of triggers) {
    let best = 0;
    for (const w of t.when) { const n = fires(w); if (n > best) best = n; }
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
  // Only lessons already delivered to this agent in this epoch can be repeated: the state first (the delivery has
  // read it in this process already), the triggers of those lessons only.
  const session = require('./lib/session.cjs');
  const a = session.read(ev.session_id).agents[session.agentOf(ev)];
  if (!a || a.epoch !== ctx.epoch || !a.shown) return null;
  const shown = new Set(Object.keys(a.shown).filter((k) => k.startsWith('lesson:')).map((k) => k.slice(7)));
  if (!shown.size) return null;
  const f = fieldsOf(ev);
  if (f.path && memoryRel(mem, f.path, ev.cwd)) return null;
  const t = match(loadTriggers(mem).filter((l) => shown.has(l.id)), f)[0];
  if (!t) return null;
  return { decision: 'deny', once: `lesson:${t.id}`, lesson: t.id, detector: `lesson:${t.id}`,
    reason: `Хаб: урок памяти «${t.id}» уже подан в этой эпохе, а вызов снова подходит под его признак — остановлен один раз.\n`
      + `${framed(lessonText(t))}\nЕсли урок здесь не к месту — повтори вызов как есть: второй раз он пройдёт.` };
}

module.exports = { memoryOf, memoryRel, realish, real, nestedQuantifier, whenProblem, lowerPattern, compileItem, literalOf, loadTriggers, fieldsOf, match,
  lessonsAfter, repeatBefore, CAP, WHEN_FIELDS };
