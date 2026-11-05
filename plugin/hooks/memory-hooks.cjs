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

module.exports = { ...hot, checkWrite, bashWritesMemory, bashWrite, mirrorEvents, commitMemory, stop, preflight };
