// Memory v2 in the hooks (slice 21): the library of the modules of the handler «memory» —
//   pretool.d/50-memory-bash-write   Bash never writes memory/lessons/** or decisions/** (deny with how to write one)
//   pretool.d/51-memory-repeat       a lesson already delivered in the epoch fires again → deny-once with its text
//   posttool.d/20-memory-write-check a lesson written by Write/Edit is validated at once (block with the problems)
//   posttool.d/21-memory-lessons     a lesson whose `when` fires on the finished call → delivered after it
//   posttoolfailure.d/21-memory-lessons-failure  the same on a failed call, `out` — the text of the error (slice 37)
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
const hot = require('./memory-hot.cjs');
const { memoryOf, memoryRel, realish, real, compileItem } = hot;

const MEMORY_DIRS = /^(lessons|decisions)(\/|$)/;

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
  const warnings = [];
  if (!problems.length) {
    const { meta } = parseLesson(buf.toString('utf8'));
    (Array.isArray(meta.when) ? meta.when : []).forEach((w, i) => {
      const c = compileItem(w);
      if (c.error) problems.push(`when[${i}].${c.error}: хук его не возьмёт`);
      else for (const x of c.warn) warnings.push(`memory/${rel}: when[${i}].${x}`);
    });
  }
  try { require('../lib/memory/store.cjs').ensureTriggers(mem); } catch { /* the next search rebuilds it */ }
  if (!problems.length) {
    // A risky but valid `when` keeps its trigger (the watchdog guards the hot path): named, not blocked.
    return warnings.length ? { items: [{ text: `Хаб: урок записан, но его триггер стоит сузить:\n${warnings.map((w) => `- ${w}`).join('\n')}`,
      priority: 'reminder', key: `memory-warn:${rel}`, source: 'memory' }] } : null;
  }
  return { decision: 'block', reason: `Хаб: урок memory/${rel} не прошёл проверку памяти:\n${problems.slice(0, 12).map((p) => `- ${p}`).join('\n')}\n`
    + 'Исправь файл (Edit/Write) — пока он с ошибкой, у урока нет триггера и подачи. Проверка всей памяти — recall check.' };
}

// ---------- Bash into the memory ----------

// Commands worth reading: they name the memory, or remove / move something (a folder that holds the memory).
const GATE = /lessons|decisions|memory|\b(?:rm|rmdir|shred|mv|find)\b/;
const DESTROY = new Set(['rm', 'unlink', 'shred', 'rmdir']);
// Programs a find -exec may run over the memory without writing it.
const FIND_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'wc', 'cat', 'head', 'tail', 'ls', 'stat', 'file', 'md5sum', 'sha1sum',
  'sha256sum', 'du', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'diff', 'cmp', 'jq', 'less']);
const WRITE_ALL = new Set(['tee', 'touch', 'truncate']);
const WRITE_TARGET = new Set(['cp', 'install', 'ln', 'rsync']);
const INTERP = new Set(['node', 'nodejs', 'python', 'python3', 'perl', 'ruby', 'deno', 'bun', 'php']);
const CODE_FLAGS = /^-(?:e|c|p|E|r|pe|ne|pi|e[a-z]*)$|^--eval$|^--print$/;
// git subcommands that write the work tree: with a path of the memory, or run inside the memory's own git.
const GIT_WRITES = new Set(['checkout', 'restore', 'rm', 'mv', 'apply', 'reset', 'clean', 'stash', 'merge', 'pull', 'cherry-pick',
  'revert', 'am', 'switch', 'read-tree', 'checkout-index']);
// In-place flags: -i, -pi, -i.bak — not -Mstrict, -Ilib, -e (perl), -E (sed).
const IN_PLACE = (x) => /^-(?![MmIeE])[a-zA-Z]*i/.test(x) || x.startsWith('--in-place');
const REDIRECT = /(?:^|[^<>&\d])(?:\d+|&)?>{1,2}\|?\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;&|()<>"']+))/g;
const ASSIGN = /(?:^|[\s;&|(])([A-Za-z_]\w*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;&|()<>"']+))/g;
const globRe = (seg) => new RegExp(`^${seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

// Arguments of a call in code text, from the index of its `(`: split on top-level commas, strings kept whole.
function callArgs(code, open) {
  const args = [];
  let depth = 0, cur = '', q = null;
  for (let i = open + 1; i < code.length && i < open + 2000; i++) {
    const c = code[i];
    if (q) { cur += c; if (c === '\\') { cur += code[++i] || ''; } else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) { args.push(cur.trim()); return args; } depth--; }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return args;
}

// A path an expression of inline code names: a string literal, a variable assigned one, or path.join / os.path.join of
// those; null — not known (then not judged).
function pathOf(expr, vars, code, depth = 0) {
  const e = String(expr || '').trim();
  const lit = /^(['"`])([^'"`]*)\1$/.exec(e);
  if (lit) return lit[2];
  if (/^[A-Za-z_]\w*$/.test(e)) return vars.has(e) ? vars.get(e) : null;
  const j = /^(?:require\(\s*['"]path['"]\s*\)\.|path\.|os\.path\.)join\s*\(/.exec(e);
  if (j && depth < 3) {
    const parts = callArgs(e, j[0].length - 1).map((x) => pathOf(x, vars, code, depth + 1));
    return parts.every((x) => typeof x === 'string') ? path.join(...parts) : null;
  }
  return null;
}

// Paths inline code (node -e, python -c, a heredoc fed to an interpreter) writes: the first argument of a write call
// (the destination of copy/move, both ends of rename), resolved through literals, assigned variables and path.join.
// A path the code only reads is not a write: a copy out of the memory passes.
function codeWrites(code) {
  const vars = new Map();
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(['"`])([^'"`\n]*)\2/g)) vars.set(m[1], m[3]);
  const out = [];
  const calls = [
    [/\b(?:writeFile|appendFile|createWriteStream|truncate|unlink|rmSync|rmdir|rm)(?:Sync)?\s*\(/g, [0]],
    [/\b(?:copyFile|cp)(?:Sync)?\s*\(/g, [1]],
    [/\brename(?:Sync)?\s*\(/g, [0, 1]],
    [/\bshutil\.(?:copy\w*)\s*\(/g, [1]],
    [/\bshutil\.move\s*\(/g, [0, 1]],
    [/\bos\.(?:remove|unlink|rmdir)\s*\(/g, [0]],
    [/\bos\.(?:rename|replace)\s*\(/g, [0, 1]],
  ];
  for (const [re, which] of calls) {
    for (const m of code.matchAll(re)) {
      const args = callArgs(code, m.index + m[0].length - 1);
      for (const k of which) { const p = pathOf(args[k], vars, code); if (p) out.push(p); }
    }
  }
  for (const m of code.matchAll(/\bopen\s*\(/g)) {
    const args = callArgs(code, m.index + m[0].length - 1);
    const mode = args.slice(1).find((x) => /^(?:mode\s*=\s*)?['"][^'"]*['"]$/.test(x));
    if (mode && /[wax+]/.test(mode.replace(/^mode\s*=\s*/, ''))) { const p = pathOf(args[0], vars, code); if (p) out.push(p); }
  }
  for (const m of code.matchAll(/\bPath\s*\(/g)) {
    const args = callArgs(code, m.index + m[0].length - 1);
    const after = code.slice(m.index + m[0].length - 1).replace(/^\((?:[^()]|\([^()]*\))*\)/, '');
    if (/^\s*\.\s*(?:write_text|write_bytes|unlink|touch|rename|replace|mkdir)\b/.test(after)) { const p = pathOf(args[0], vars, code); if (p) out.push(p); }
  }
  return out;
}

// The first path of the memory's lessons/ or decisions/ the command writes or destroys, or null. Writes: a redirection
// (variables assigned in the command expanded), tee/touch/truncate, rm/rmdir/shred/unlink (also of a folder that holds
// the memory), mv (both ends), find -delete / -exec, the target of cp/install/ln/rsync (the memory itself when a
// lessons/ or decisions/ folder is copied in), sed -i / perl -i / awk -i inplace, patch, dd of=, curl -o / wget -O,
// tar -x -C, git commands that write the work tree, inline code of an interpreter. Globs in the first segment under
// the memory are matched against lessons/ and decisions/. Reads pass.
function bashWritesMemory(cmd, cwd, mem) {
  if (typeof cmd !== 'string' || !GATE.test(cmd)) return null;
  const { executions } = require('../skills/dispatch/scripts/shell.cjs');
  let execs = [];
  try { execs = executions(cmd, { cwd: cwd || '/' }).execs || []; } catch { execs = []; }
  const base0 = cwd || '/';
  const bases = [base0];
  for (const e of execs) {
    const n = path.basename(String(e.argv[0] || ''));
    if ((n === 'cd' || n === 'pushd') && e.argv[1] && !e.argv[1].startsWith('-')) bases.push(path.resolve(base0, e.argv[1]));
  }
  const vars = new Map();
  for (const m of cmd.matchAll(ASSIGN)) vars.set(m[1], m[2] ?? m[3] ?? m[4]);
  const expand = (tok) => String(tok).replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => (vars.has(a || b) ? vars.get(a || b) : all));
  const memReal = real(mem);
  // kind: 'write' — lessons/ or decisions/ (or below); 'into' — also the memory folder itself; 'destroy' — also any
  // folder that holds the memory.
  const hit = (tok, kind = 'write', bs = bases) => {
    if (typeof tok !== 'string' || !tok) return null;
    const t = expand(tok);
    if (t.startsWith('-') || t.includes('$')) return null;
    for (const b of bs) {
      const abs = realish(path.resolve(b, t));
      const rel = path.relative(memReal, abs).split(path.sep).join('/');
      if (kind === 'destroy' && !path.relative(abs, memReal).startsWith('..')) return tok;
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (rel === '') { if (kind !== 'write') return tok; continue; }
      const seg = rel.split('/')[0];
      if (/^(lessons|decisions)$/.test(seg) || (/[*?[]/.test(seg) && ['lessons', 'decisions'].some((d) => globRe(seg).test(d)))) return tok;
    }
    return null;
  };
  const codeHit = (code, bs = bases) => codeWrites(code).map((p) => hit(p, 'write', bs)).find(Boolean) || null;
  const opt = (args, names) => {
    for (let i = 0; i < args.length; i++) {
      for (const nm of names) {
        if (args[i] === nm) return args[i + 1];
        if (nm.startsWith('--') && args[i].startsWith(`${nm}=`)) return args[i].slice(nm.length + 1);
        if (!nm.startsWith('--') && args[i].startsWith(nm) && args[i].length > nm.length && nm.length === 2) return args[i].slice(2);
      }
    }
    return null;
  };

  for (const m of cmd.matchAll(REDIRECT)) { const t = hit(m[1] ?? m[2] ?? m[3]); if (t) return t; }
  for (const e of execs) {
    const a = e.argv.map(String);
    const n = path.basename(a[0] || '');
    const args = a.slice(1);
    const plain = args.filter((x) => !x.startsWith('-'));
    let t = null;
    if (DESTROY.has(n)) t = plain.map((x) => hit(x, 'destroy')).find(Boolean);
    else if (WRITE_ALL.has(n)) t = plain.map((x) => hit(x)).find(Boolean);
    else if (n === 'mv') {
      const target = plain[plain.length - 1], sources = plain.slice(0, -1);
      t = sources.map((x) => hit(x, 'destroy')).find(Boolean) || hit(target)
        || (sources.some((x) => /^(lessons|decisions)$/.test(path.basename(expand(x).replace(/\/+$/, '')))) ? hit(target, 'into') : null);
    }
    else if (WRITE_TARGET.has(n)) {
      const target = opt(args, ['-t', '--target-directory']) ?? plain[plain.length - 1];
      const sources = opt(args, ['-t', '--target-directory']) != null ? plain.filter((x) => x !== target) : plain.slice(0, -1);
      t = hit(target) || (sources.some((x) => /^(lessons|decisions)$/.test(path.basename(expand(x).replace(/\/+$/, '')))) ? hit(target, 'into') : null);
    } else if (n === 'find') {
      // -delete, or any -exec / -ok whose program is not a known reader (sh -c, env rm, gzip … write): the start paths
      // inside the memory are judged. A folder above the memory is not: find deletes by its mask, not the memory.
      const progs = args.flatMap((x, k) => (/^-(exec|execdir|ok|okdir)$/.test(x) ? [path.basename(String(args[k + 1] || ''))] : []));
      if (args.includes('-delete') || progs.some((p) => !FIND_READERS.has(p))) {
        const starts = [];
        for (const x of args) { if (x.startsWith('-') || x === '(' || x === '!') break; starts.push(x); }
        t = starts.map((x) => hit(x, 'into')).find(Boolean);
      }
    } else if ((n === 'sed' || n === 'perl') && args.some(IN_PLACE)) t = plain.map((x) => hit(x)).find(Boolean);
    else if ((n === 'awk' || n === 'gawk') && (args.some((x, i) => x === '-i' && args[i + 1] === 'inplace') || args.includes('--inplace'))) t = plain.map((x) => hit(x)).find(Boolean);
    else if (n === 'patch') t = hit(opt(args, ['-o', '--output'])) || hit(plain[0]);
    else if (n === 'dd') t = args.filter((x) => x.startsWith('of=')).map((x) => hit(x.slice(3))).find(Boolean);
    else if (n === 'curl') t = hit(opt(args, ['-o', '--output'])) || hit(opt(args, ['--output-dir']));
    else if (n === 'wget') {
      // A recursive download into the memory makes its folders (lessons/ too); a single file there does not.
      const deep = args.some((x) => /^-[a-zA-Z]*[rm]/.test(x) && !x.startsWith('--') || x === '--recursive' || x === '--mirror');
      t = hit(opt(args, ['-O', '--output-document'])) || hit(opt(args, ['-P', '--directory-prefix']), deep ? 'into' : 'write');
    }
    else if (n === 'tar' && ((args[0] && /^[a-zA-Z]*x[a-zA-Z]*$/.test(args[0])) || args.some((x) => /^-[a-zA-Z]*x[a-zA-Z]*$/.test(x)) || args.includes('--extract'))) {
      t = hit(opt(args, ['-C', '--directory']), 'into');
    }
    else if (n === 'git') {
      let i = 0, dir = base0;
      while (i < args.length && args[i].startsWith('-')) {
        if (args[i] === '-C' && args[i + 1]) { dir = path.resolve(dir, expand(args[i + 1])); i += 2; } else if (args[i] === '-c') i += 2; else i++;
      }
      const sub = args[i], rest = args.slice(i + 1);
      // Forms that leave the work tree as it is: stash list/show, reset --soft / --mixed without paths, rm --cached.
      const reads = (sub === 'stash' && ['list', 'show'].includes(rest[0]))
        || (sub === 'reset' && !rest.some((x) => /^--(hard|merge|keep)$/.test(x)))
        || (sub === 'rm' && rest.includes('--cached'));
      if (GIT_WRITES.has(sub) && !reads) {
        const paths = rest.filter((x) => !x.startsWith('-'));
        t = paths.map((x) => hit(x, 'write', [dir])).find(Boolean) || null;
        const inside = path.relative(memReal, realish(dir));
        if (!t && !inside.startsWith('..') && !path.isAbsolute(inside)) t = `git -C ${path.relative(base0, dir) || '.'} ${args[i]}`;
      }
    } else if (INTERP.has(n)) {
      for (let k = 0; k < args.length && !t; k++) if (CODE_FLAGS.test(args[k]) && typeof args[k + 1] === 'string') t = codeHit(args[k + 1]);
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
  // For memory written past the write check: a `when` that does not compile, one that may backtrack long (a warning),
  // and a source the watchdog cut twice — in the quarantine, skipped by the hot path until the lesson's `when` changes.
  const q = hot.readQuarantine(mem);
  const warnings = [];
  for (const t of hot.loadTriggers(mem)) {
    t.when.forEach((w, i) => {
      const c = compileItem(w);
      if (c.error) problems.push(`lessons/${t.id}.md: when[${i}].${c.error}`);
      else for (const x of c.warn) warnings.push(`lessons/${t.id}.md: when[${i}].${x}`);
      for (const [k, src] of Object.entries(w && typeof w === 'object' ? w : {})) {
        if (typeof src === 'string' && q[hot.keyOf(src)]) problems.push(`lessons/${t.id}.md: when[${i}].${k} в карантине — сторож дважды прервал его на поле ${q[hot.keyOf(src)].field}; поправь регэксп, правка снимет карантин`);
      }
    });
  }
  if (!problems.length && !warnings.length) return null;
  const list = (xs, n) => [...xs.slice(0, n).map((p) => `- ${p}`), ...(xs.length > n ? [`- … ещё ${xs.length - n} — recall check`] : [])];
  const parts = [];
  if (problems.length) {
    parts.push(`Память v2 проекта ${ctx.project.name}: проблем ${problems.length} — вызовы не блокируются, но урок с ошибкой не подаётся. `
      + 'Исправь файлы (Edit/Write), проверка всей памяти — recall check:', ...list(problems, 20));
  }
  // A warning is no problem: the lesson is delivered, its trigger is worth narrowing (the watchdog guards the hot path).
  if (warnings.length) parts.push(`Память v2 проекта ${ctx.project.name}: предупреждений ${warnings.length} — уроки подаются, но триггеры стоит сузить:`, ...list(warnings, 10));
  return { items: [{ text: parts.join('\n'), priority: 'reminder', key: 'memory-check', source: 'memory' }] };
}

module.exports = { ...hot, GATE, checkWrite, bashWritesMemory, bashWrite, mirrorEvents, commitMemory, stop, preflight };
