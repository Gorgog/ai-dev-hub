// The part of the weekly cycle (weekly.py) that reads and writes with the hub's own code: stdin - one JSON request,
// stdout - one JSON answer.
//   {op: 'read', calls, projects, hub, base_rules, events_dir, since, until, rules_since}
//     calls - the window's tool calls in order: {id, t, session, agent, epoch, n, project, tool, cmd, path, is_error}
//     → {calls: {id: {sig, push, push_slice, parallel_check}}, rules, delivery, lessons, retire}
//       sig - what ran, for failure clusters: the first program that is no wrapper, set-up (cd, export) or filter
//             (tail, grep) — «Bash: npx jest», «Bash: git push»; the tool's name for other tools; push / push_slice / parallel_check - the dispatcher's gates
//       rules - {project: {rule: {mode, hits, windows, prevented, repeat, expired, rate, per100}}}: rules-guard
//             (base-rules.json + the project's rules.json) replayed over the calls; a hit outside an open window is
//             a reminder and opens one - the next 3 calls of the same epoch of the same agent (a rough measure: the
//             delivery shows a rule once an epoch, so «prevented» here asks whether the rule fires again after a hit); the rule again in it -
//             repeat, 3 calls without it - prevented, the epoch over first - expired. Hits before rules_since
//             ["<project>/<rule>"] (its last promotion) are not counted: the rule was in another mode. per100 - hits
//             per 100 calls of the project in the window, every tool.
//       delivery - the «prevented» counter of the delivery's journal (12) over the window, null without a journal
//       lessons - v2 memory: {project: {lesson: {kind, shown, repeat}}} for lessons with events in the window
//       retire - v2 memory: lessons past their own retirement condition at `until` (store.retirementCandidates)
//       knowledge - v2 memory: knowledge lessons that repeated (a 2nd similar episode: a rule candidate, rule 7)
//   {op: 'apply', hub, events_dir, actions}  - promote (mode in the project's rules.json), retire (store.retire);
//     every action and question becomes an event of the journal (kind = action kind, mode: 'improve')
//   {op: 'revert', hub, events_dir, id}  - undo one applied action by its id; the undo is an event too (kind revert)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { execs } = require(path.join(ROOT, 'tools', 'analytics', 'shell-read.cjs'));
const { evaluate } = require(path.join(ROOT, 'plugin', 'hooks', 'rules-guard.cjs'));
const events = require(path.join(ROOT, 'plugin', 'hooks', 'lib', 'events.cjs'));
const memEvents = require(path.join(ROOT, 'plugin', 'lib', 'memory', 'events.cjs'));
const store = require(path.join(ROOT, 'plugin', 'lib', 'memory', 'store.cjs'));

const K = 3;
const WRAPPERS = new Set(['timeout', 'env', 'nice', 'ionice', 'nohup', 'sudo', 'time', 'xargs', 'stdbuf', 'setsid', 'exec',
  'command', 'hub-run.sh', 'flock', 'watch', 'cross-env', 'dotenv']);
// Set-up and filters around the program that failed: `cd x && npx jest 2>&1 | tail` failed in jest.
const AROUND = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'true', ':', 'echo', 'printf', 'sleep',
  'mkdir', 'test', '[', 'local', 'declare', 'tail', 'head', 'grep', 'tee', 'wc', 'sort', 'uniq', 'cut', 'tr']);
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun']);
const SCRIPTED = new Set(['node', 'python', 'python3', 'bash', 'sh']);
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const base = (p) => path.basename(String(p || ''));
const firstArg = (argv, from = 1) => argv.slice(from).find((a) => !a.startsWith('-')) || '';

function gitSub(argv) {
  if (!/^git(\.exe)?$/.test(base(argv[0]))) return null;
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) i += GIT_ARG_OPTS.has(argv[i]) ? 2 : 1;
  return argv[i] || '';
}

// A program run, as it names itself: a script by its file (`node x/push-slice.cjs` and the script run alone).
const runs = (runList, name) => runList.some(({ argv }) => base(argv[0]) === name || (SCRIPTED.has(base(argv[0])) && base(firstArg(argv)) === name));

function signature(tool, runList, cmd) {
  if (tool !== 'Bash' && tool !== 'PowerShell') return tool;
  const own = ({ argv }) => argv.length && !WRAPPERS.has(base(argv[0])) && !(SCRIPTED.has(base(argv[0])) && argv[1] === '-c');
  const r = runList.find((x) => own(x) && !AROUND.has(base(x.argv[0]))) || runList.find(own);
  if (!r) return `${tool}: ${String(cmd || '').trim().split(/\s+/)[0] || '?'}`;
  const { argv } = r;
  const name = base(argv[0]);
  const g = gitSub(argv);
  if (g !== null) return `${tool}: git ${g}`.trim();
  if (RUNNERS.has(name)) {
    const a = firstArg(argv);
    return `${tool}: ${name} ${['exec', 'run', 'dlx', 'x'].includes(a) ? `${a} ${firstArg(argv, argv.indexOf(a) + 1)}` : a}`.trim();
  }
  if (SCRIPTED.has(name) && firstArg(argv)) return `${tool}: ${name} ${base(firstArg(argv))}`;
  return `${tool}: ${name}`;
}

// The project's rules as rules-guard sees them, with the mode as written (rules-guard reads an unknown mode as log).
function projectRules(hub, baseFile, project) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const baseRules = read(baseFile) || [];
  const proj = project ? read(path.join(hub, 'projects', project, 'rules.json')) || {} : {};
  const own = Array.isArray(proj) ? proj : proj.rules || [];
  const modes = Array.isArray(proj) ? {} : proj.modes || {};
  return [...baseRules, ...own].filter((r) => r && typeof r === 'object' && r.id)
    .map((r) => ({ ...r, mode: modes[r.id] || r.mode || 'log' }));
}

function replay(req) {
  const out = {};
  const ruleSets = new Map();
  const groups = new Map();
  const total = {}; // calls of the project in the window, every tool: the base of «per 100 calls»
  for (const c of req.calls) {
    const p = c.project || '';
    if (!ruleSets.has(p)) ruleSets.set(p, projectRules(req.hub, req.base_rules, c.project));
    total[p] = (total[p] || 0) + 1;
    const k = `${c.session}\u0000${c.agent}\u0000${c.epoch}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const since = req.rules_since || {};
  const R = (p, r) => {
    const byRule = (out[p || '(без проекта)'] ||= {});
    return (byRule[r.id] ||= { mode: r.mode, hits: 0, windows: 0, prevented: 0, repeat: 0, expired: 0 });
  };
  for (const list of groups.values()) {
    list.sort((a, b) => a.n - b.n);
    const open = new Map(); // rule id → calls left in its window
    for (const c of list) {
      const p = c.project || '';
      const rules = ruleSets.get(p);
      const ev = { tool_name: c.tool, tool_input: c.tool === 'Bash' ? { command: c.cmd || '' } : { file_path: c.path || '' } };
      const hit = new Set(evaluate(ev, rules).hits.map((h) => h.id));
      for (const [id, left] of [...open]) {
        const s = R(p, rules.find((r) => r.id === id));
        if (hit.has(id)) { s.repeat++; open.delete(id); hit.delete(id); s.hits++; continue; }
        if (left === 1) { s.prevented++; open.delete(id); } else open.set(id, left - 1);
      }
      for (const id of hit) {
        const rule = rules.find((r) => r.id === id);
        const from = since[`${p}/${id}`];
        if (from && c.t <= from) continue;
        const s = R(p, rule);
        s.hits++;
        s.windows++;
        open.set(id, K);
      }
    }
    for (const id of open.keys()) {
      const p = list[0].project || '';
      R(p, ruleSets.get(p).find((r) => r.id === id)).expired++;
    }
  }
  for (const [p, byRule] of Object.entries(out)) {
    const n = total[p === '(без проекта)' ? '' : p] || 0;
    for (const s of Object.values(byRule)) {
      s.rate = s.prevented + s.repeat ? Math.round(1000 * s.prevented / (s.prevented + s.repeat)) / 1000 : null;
      s.per100 = n ? Math.round(1000 * 100 * s.hits / n) / 1000 : null;
    }
  }
  return out;
}

const inWindow = (at, req) => typeof at === 'string' && at >= req.since && at < req.until;

function delivery(req) {
  if (!req.events_dir) return null;
  const list = events.files(req.events_dir);
  if (!list.length) return null;
  const all = list.flatMap((f) => events.read(f).events).filter((e) => e.mode !== 'improve' && inWindow(e.at, req));
  const s = events.stats(all);
  return { lessons: s.lessons, rules: s.rules, total: s.total };
}

function memory(req) {
  const lessons = {}, retire = [], knowledge = [];
  for (const p of req.projects) {
    const mem = path.join(req.hub, 'projects', p, 'memory');
    if (!fs.existsSync(path.join(mem, 'lessons'))) continue;
    const kinds = Object.fromEntries(store.fold(mem).entries.filter((e) => e.dir === 'lessons').map((e) => [e.id, e.kind]));
    for (const e of memEvents.readEvents(mem).events) {
      if (!e.lesson || !inWindow(e.at, req) || !['shown', 'repeat'].includes(e.kind)) continue;
      const l = ((lessons[p] ||= {})[e.lesson] ||= { kind: kinds[e.lesson] || null, shown: 0, repeat: 0 });
      l[e.kind]++;
    }
    const repeated = new Set(memEvents.readEvents(mem).events.filter((e) => e.kind === 'repeat').map((e) => e.lesson));
    for (const id of store.retirementCandidates(mem, { now: new Date(req.until) })) retire.push({ project: p, lesson: id });
    for (const [id, kind] of Object.entries(kinds)) if (kind === 'knowledge' && repeated.has(id)) knowledge.push({ project: p, lesson: id });
  }
  return { lessons, retire, knowledge };
}

function read(req) {
  const calls = {};
  for (const c of req.calls) {
    const list = c.tool === 'Bash' || c.tool === 'PowerShell' ? execs(c.cmd || '') : [];
    calls[c.id] = { sig: signature(c.tool, list, c.cmd), push: list.some(({ argv }) => gitSub(argv) === 'push'),
      push_slice: runs(list, 'push-slice.cjs'), parallel_check: runs(list, 'parallel-check.sh') };
  }
  const { lessons, retire, knowledge } = memory(req);
  return { calls, rules: replay(req), delivery: delivery(req), lessons, retire, knowledge };
}

// ---------- writing ----------

const rulesFile = (hub, project) => path.join(hub, 'projects', project, 'rules.json');

// rules.json keeps its shape: an array of rules becomes {rules, modes} only when a mode is set; written via tmp+rename.
function setMode(hub, project, rule, mode, deflt) {
  const f = rulesFile(hub, project);
  let j = {};
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (Array.isArray(j)) j = { rules: j };
  const modes = { ...(j.modes || {}) };
  if (mode === deflt) delete modes[rule]; else modes[rule] = mode;
  const next = { ...j, modes };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.improve-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + '\n');
  fs.renameSync(tmp, f);
}

// The mode written for a rule in the project's `modes`, or null.
function currentMode(hub, project, rule) {
  try { const j = JSON.parse(fs.readFileSync(rulesFile(hub, project), 'utf8')); return (!Array.isArray(j) && j.modes && j.modes[rule]) || null; } catch { return null; }
}

// The mode a rule has with no entry in `modes`: its own (base-rules.json or the project's rule), else log.
function ownMode(req, project, rule) {
  const r = projectRules(req.hub, req.base_rules, null).concat((() => {
    try { const j = JSON.parse(fs.readFileSync(rulesFile(req.hub, project), 'utf8')); return Array.isArray(j) ? j : j.rules || []; } catch { return []; }
  })()).find((x) => x && x.id === rule);
  return (r && r.mode) || 'log';
}

const addr = { session_id: 'improve', agent_id: '', tool_use_id: null, epoch: null, model: null };
const ev = (a, extra = {}) => {
  const { id, kind, project, rule, lesson, from, to, what, title, reason, text } = a;
  return { ...addr, kind, id, project, rule, lesson, from, to, what, title, reason: reason || text, mode: 'improve', ...extra };
};

// The status line of a lesson's frontmatter (LF or CRLF, as written); a lesson without one is an error, not a no-op.
function setStatus(file, status) {
  const text = fs.readFileSync(file, 'utf8');
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!fm || !/^status:[ \t]*[^\r\n]*$/m.test(fm[0])) throw new Error(`${file}: в frontmatter нет строки status`);
  const next = fm[0].replace(/^status:[ \t]*[^\r\n]*$/m, () => `status: ${status}`) + text.slice(fm[0].length);
  const tmp = `${file}.improve-${process.pid}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);
}

function apply(req) {
  const done = [];
  for (const a of req.actions) {
    try {
      if (a.kind === 'promote') setMode(req.hub, a.project, a.rule, a.to, ownMode(req, a.project, a.rule));
      if (a.kind === 'retire') store.retire(path.join(req.hub, 'projects', a.project, 'memory'), a.lesson, addr);
      if (a.kind === 'candidate' && a.file) {
        fs.mkdirSync(path.dirname(a.file), { recursive: true });
        if (!fs.existsSync(a.file)) fs.writeFileSync(a.file, a.stub);
      }
      done.push(ev(a));
    } catch (e) {
      // a failure keeps the action's id apart: the action is not «seen», it is offered again next week
      done.push(ev(a, { kind: 'failed', id: undefined, action_id: a.id, action: a.kind, reason: String(e.message).split('\n')[0] }));
    }
  }
  events.append(done, req.events_dir);
  return { applied: done.filter((e) => e.kind !== 'failed').length, failed: done.filter((e) => e.kind === 'failed') };
}

function revert(req) {
  const all = events.files(req.events_dir).flatMap((f) => events.read(f).events).filter((e) => e.mode === 'improve');
  const a = all.find((e) => e.id === req.id && ['promote', 'retire'].includes(e.kind));
  if (!a) throw new Error(`действие ${req.id} не найдено (откатываются promote и retire)`);
  if (all.some((e) => e.kind === 'revert' && e.of === req.id)) throw new Error(`действие ${req.id} уже откачено`);
  // Undo only what is still as the cycle left it: a mode or a status changed since is someone's decision.
  if (a.kind === 'promote') {
    const own = ownMode(req, a.project, a.rule);
    const now = currentMode(req.hub, a.project, a.rule) || own;
    if (now !== a.to) throw new Error(`правило ${a.rule} (${a.project}) сейчас в режиме ${now}, а цикл ставил ${a.to}: откат не делаю`);
    setMode(req.hub, a.project, a.rule, a.from, own);
  }
  if (a.kind === 'retire') {
    const mem = path.join(req.hub, 'projects', a.project, 'memory');
    const file = path.join(mem, 'lessons', `${a.lesson}.md`);
    if (!/^status:[ \t]*retired[ \t]*\r?$/m.test(fs.readFileSync(file, 'utf8'))) throw new Error(`урок ${a.lesson} (${a.project}) уже не в отставке: откат не делаю`);
    setStatus(file, 'active');
    store.ensureTriggers(mem);
    memEvents.appendEvent(mem, { ...addr, kind: 'restored', lesson: a.lesson });
  }
  events.append([{ ...addr, kind: 'revert', of: a.id, id: `${a.id}r`, project: a.project, rule: a.rule, lesson: a.lesson,
    from: a.to, to: a.from, mode: 'improve' }], req.events_dir);
  return { reverted: a.id, kind: a.kind };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let out;
  try {
    const req = JSON.parse(input);
    out = req.op === 'read' ? read(req) : req.op === 'apply' ? apply(req) : req.op === 'revert' ? revert(req) : (() => { throw new Error(`op ${req.op}`); })();
  } catch (e) {
    process.stderr.write(`hub-io: ${e.message}\n`, () => process.exit(1));
    return;
  }
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
});
