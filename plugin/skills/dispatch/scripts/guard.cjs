#!/usr/bin/env node
// PreToolUse hook: the dispatcher's resource lock, enforced.
// Acts ONLY when the session's cwd is inside <hub>/projects/<project>/worktrees/<worktree>/ and the project has
// <hub>/projects/<project>/dispatch-rules.json. Then a tool call that matches a "heavy" or "medium" rule is
// blocked (exit 2, reason on stderr -> shown to Claude) unless <project>/memory/dispatch-grants.json grants that
// kind to this worktree (written by grant.cjs on the dispatcher's side) and the grant has not expired.
// A heavy grant also covers medium. Every rule hit is journaled to <project>/memory/dispatch-guard.log
// (one JSON line: time, worktree, granted/blocked, rule, how it was judged, command). Anything else, or any internal
// error, is allowed (fail-open): the hook must never break sessions outside the dispatcher's scope.
// How a Bash command meets a rule's `commands` regexp (decide(ev, { by })):
//   by 'text'    — the regexp on the whole command text (v1; the module 10-lock, and lock-program at stage off);
//   by 'program' — on the programs the command really runs (shell.cjs: wrappers, env, npx, subshells, variables,
//                  scripts), one line per program: `NAME=v … prog args`, package binaries also as `npx bin args`,
//                  npm/pnpm/yarn/bun script runs also as `npm run <script>`. A hit counts only if it rests on the
//                  program: the same regexp on the line with the program word replaced must not match too (so
//                  `grep "npx jest"` or `git commit -m "kubb generate"` is no hit), and arguments with blanks
//                  (messages, patterns, code strings) are masked. Unparsed command or a program known only at run
//                  time — the whole text, as by 'text'. dispatch-rules.json keeps its format.
// The plugin's hooks/pretool.d/10-lock.cjs and 11-lock-program.cjs call decide(); run as a script it is the old
// standalone hook (by text).
'use strict';
const fs = require('fs');
const path = require('path');

function locate(cwd) {
  const norm = String(cwd || '').replace(/\\/g, '/');
  const m = norm.match(/^(.*\/projects\/[^/]+)\/worktrees\/([^/]+)(?:\/|$)/i);
  if (!m) return null;
  return { projectDir: m[1], holder: m[2] };
}

// Top-level alternatives of a regexp source (a|b|c → [a, b, c]); each branch is judged on its own, so an
// alternative that matched an argument does not hide one that matched the program.
function branches(src) {
  const out = [];
  let depth = 0, cls = false, from = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (cls) { if (c === ']') cls = false; continue; }
    if (c === '[') cls = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) { out.push(src.slice(from, i)); from = i + 1; }
  }
  out.push(src.slice(from));
  try { return out.map((b) => new RegExp(b, 'i')); } catch { return [new RegExp(src, 'i')]; }
}

const SAFE = /^[A-Za-z0-9_@%+=:,./~^-]+$/;
const quote = (t) => (SAFE.test(t) ? t : /\s/.test(t) ? "''" : `'${t.replace(/'/g, "'\\''")}'`);
const PM = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_VALUED = ['--prefix', '-w', '--workspace', '--loglevel', '--userconfig', '--cache', '--registry', '--filter', '-F',
  '-C', '--dir', '--workspace-dir', '--reporter', '--cwd', '--config'];
const RUN = ['run', 'run-script', 'rum', 'urn'];
const LIFECYCLE = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' };
const INSTALL = ['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add'];
const CI = ['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean'];
// Subcommands of pnpm / yarn / bun that are not «run the script of that name».
const BUILTIN = new Set(['add', 'install', 'i', 'update', 'up', 'upgrade', 'remove', 'rm', 'link', 'unlink', 'import', 'rebuild',
  'prune', 'fetch', 'patch', 'audit', 'list', 'ls', 'outdated', 'why', 'exec', 'dlx', 'x', 'create', 'init', 'publish', 'pack',
  'store', 'env', 'setup', 'config', 'root', 'bin', 'server', 'deploy', 'licenses', 'doctor', 'help', 'info', 'workspaces',
  'workspace', 'cache', 'global', 'set', 'plugin', 'constraints', 'node', 'npm', 'version', 'login', 'logout', 'tag', 'team',
  'owner', 'policies', 'check', 'autoclean', 'pm', 'build', 'repl']);

// Canonical npm forms of a package manager call: `pnpm --filter web run dev` → npm run dev, `yarn dev` → npm run dev
// (and npx dev: yarn and pnpm fall back to a binary), `yarn` → npm install.
function pmForms(argv) {
  const name = path.basename(argv[0]);
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') i += PM_VALUED.includes(argv[i]) ? 2 : 1;
  const sub = argv[i], rest = argv.slice(i + 1);
  if (sub === undefined) return name === 'yarn' ? [['npm', 'install']] : [];
  if (RUN.includes(sub)) {
    let j = 0;
    while (j < rest.length && rest[j].startsWith('-')) j++;
    return rest[j] ? [['npm', 'run', ...rest.slice(j)]] : [];
  }
  if (LIFECYCLE[sub] && name !== 'bun') return [['npm', 'run', LIFECYCLE[sub], ...rest]];
  if (INSTALL.includes(sub)) return [['npm', 'install', ...rest]];
  if (CI.includes(sub)) return [['npm', 'ci', ...rest]];
  if (name === 'yarn' && sub === 'workspace') return rest[1] ? pmForms(['yarn', ...rest.slice(1)]) : [];
  if (name !== 'npm' && !BUILTIN.has(sub) && !sub.startsWith('-'))
    return name === 'bun' ? [['npm', 'run', sub, ...rest]] : [['npm', 'run', sub, ...rest], ['npx', sub, ...rest]];
  return [];
}

// Lines a rule's `commands` regexp is tried on: { text, cf } — cf is the same line with the program word replaced.
function views(cmd, cwd) {
  const { executions } = require('./shell.cjs');
  const r = executions(cmd, { cwd });
  const lines = [];
  const line = (env, argv) => {
    const pre = Object.entries(env).map(([k, v]) => `${k}=${quote(v)} `).join('');
    const rest = argv.slice(1).map(quote).join(' ');
    const tail = rest ? ` ${rest}` : '';
    lines.push({ text: `${pre}${quote(argv[0])}${tail}`, cf: `${pre}_${tail}` });
  };
  for (const e of r.execs) {
    line(e.env, e.argv);
    if (e.bin) line(e.env, ['npx', ...e.argv]);
    if (PM.has(path.basename(e.argv[0]))) for (const f of pmForms(e.argv)) line(e.env, f);
  }
  const why = r.error ? `не разобрал команду (${r.error})` : r.unknown.length ? r.unknown[0] : null;
  return { lines, why };
}

// Does a Bash command meet the regexp source? → null, or { program } (the line it hit), or { text: why } (by text).
function commandHit(src, cmd, how) {
  if (how.by !== 'program') return new RegExp(src, 'i').test(cmd) ? {} : null;
  if (!how.v) how.v = views(cmd, how.cwd);
  const bs = branches(src);
  for (const l of how.v.lines) {
    for (const b of bs) if (b.test(l.text) && (!b.test(l.cf) || b.test('_'))) return { program: l.text };
  }
  if (how.v.why && new RegExp(src, 'i').test(cmd)) return { text: how.v.why };
  return null;
}

function matches(rule, toolName, toolInput, how) {
  if (rule.tools && !new RegExp(rule.tools, 'i').test(toolName)) return null;
  let hit = {};
  if (rule.commands) {
    const cmd = toolInput && typeof toolInput.command === 'string' ? toolInput.command : null;
    if (cmd === null) return null;
    hit = commandHit(rule.commands, cmd, how);
    if (!hit) return null;
  }
  if (rule.input && !new RegExp(rule.input, 'i').test(JSON.stringify(toolInput || {}))) return null;
  return rule.tools || rule.commands || rule.input ? hit : null;
}

// null — allow; { reason } — block. opts.by: 'text' (default, v1) | 'program'.
function decide(ev, opts = {}) {
  const where = locate(ev.cwd);
  if (!where) return null;

  const rulesPath = path.join(where.projectDir, 'dispatch-rules.json');
  if (!fs.existsSync(rulesPath)) return null;
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const how = { by: opts.by === 'program' ? 'program' : 'text', cwd: ev.cwd, v: null };

  let kind = null, hit = null, why = null;
  for (const k of ['heavy', 'medium']) {
    for (const r of rules[k] || []) {
      why = matches(r, ev.tool_name || '', ev.tool_input, how);
      if (why) { kind = k; hit = r; break; }
    }
    if (kind) break;
  }
  if (!kind) return null;

  let grants = {};
  const grantsPath = path.join(where.projectDir, 'memory', 'dispatch-grants.json');
  try { grants = JSON.parse(fs.readFileSync(grantsPath, 'utf8')); } catch { grants = {}; }
  const now = Date.now();
  const valid = (g) => g && g.holder === where.holder && (!g.until || Date.parse(g.until) > now);
  // Journal of every rule hit (granted or blocked): proves the lock works and shows rules that misfire.
  const log = (decision) => {
    try {
      const what = typeof (ev.tool_input || {}).command === 'string' ? ev.tool_input.command : JSON.stringify(ev.tool_input || {});
      const rec = { at: new Date(now).toISOString(), worktree: where.holder, decision, kind, rule: hit.name, by: how.by,
        tool: ev.tool_name, what: what.slice(0, 200) };
      if (why.program) rec.program = why.program.slice(0, 200);
      if (why.text) rec.fallback = why.text.slice(0, 200);
      fs.appendFileSync(path.join(where.projectDir, 'memory', 'dispatch-guard.log'), JSON.stringify(rec) + '\n');
    } catch { /* journal must never break the hook */ }
  };
  if (valid(grants[kind]) || (kind === 'medium' && valid(grants.heavy))) { log('granted'); return null; }
  log('blocked');

  const label = kind === 'heavy' ? 'тяжёлое' : 'среднее';
  const cur = grants[kind];
  const t = (x) => (x ? new Date(x).toLocaleString('ru-RU') : '');
  const busy = cur && cur.holder
    ? (cur.holder === where.holder
        ? `Твоё разрешение истекло (${t(cur.until)}).`
        : `Сейчас держит: ${cur.holder}${cur.what ? ' (' + cur.what + ')' : ''}${cur.until ? ' до ' + t(cur.until) : ''}.`)
    : 'Сейчас никто не держит.';
  const seen = why.program ? `Программа: ${why.program.slice(0, 160)}\n`
    : why.text ? `По тексту команды: ${why.text.slice(0, 160)}\n` : '';
  return { reason:
    `Заблокировано замком диспетчера: «${hit.name}» — ${label}. ${busy}\n` + seen +
    `Напиши диспетчеру: «Прошу ${hit.name} на ~N мин: <зачем>» и дождись «Разрешаю». Пока делай лёгкое.\n` +
    `(worktree «${where.holder}», правила — ${rulesPath})\n` };
}

// Is the module lock-program (11-lock-program.cjs) live for this project — by the same rule the spine uses: its
// file exists; stage from plugin/mechanisms/lock-program.json (no record or a broken one — «on»); «canary» — only
// where projects/<name>/canary.json lists it. Then 10-lock (by text) steps aside.
function programLockActive(pluginDir, project) {
  if (!fs.existsSync(path.join(pluginDir, 'hooks', 'pretool.d', '11-lock-program.cjs'))) return false;
  let stage = 'on';
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mechanisms', 'lock-program.json'), 'utf8'));
    if (['off', 'canary', 'on'].includes(rec.stage)) stage = rec.stage;
  } catch { /* the spine runs a module without a valid record as «on» */ }
  if (stage !== 'canary') return stage === 'on';
  if (!project) return false;
  try { return (JSON.parse(fs.readFileSync(path.join(project.dir, 'canary.json'), 'utf8')).mechanisms || []).includes('lock-program'); }
  catch { return false; }
}

if (require.main === module) {
  try {
    let ev = {};
    try { ev = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
    const r = decide(ev);
    if (r) { process.stderr.write(r.reason); process.exit(2); }
  } catch { /* fail-open */ }
  process.exit(0);
}

module.exports = { decide, locate, programLockActive };
