// bare-push (slice 18): a bare `git push` that acts inside the hub — its root (the hub's dispatcher folder), a project's
// repo/ (a project's dispatcher folder), a worktree (a task session never pushes) — is denied with the way through:
// the dispatcher pushes only with dispatch/scripts/push-slice.cjs, whose gates check the receipt, parallel-check and
// the history. push-slice itself runs git in a child process, so the hook never sees its push. Programs are read with
// the lock's shell reader (wrappers, bash -c, subshells); what cannot be known before the run is judged by its text.
// Where git acts: `git -C <dir>` and a literal `cd` before it; a variable there — the session's cwd.
'use strict';
const os = require('os');
const path = require('path');
const { executions } = require('../skills/dispatch/scripts/shell.cjs');
const { HUB_ROOT, real } = require('./lib/hub.cjs');

const SCRIPT = path.resolve(__dirname, '..', 'skills', 'dispatch', 'scripts', 'push-slice.cjs');
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const PUSH_VALUED = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
// By text: git, its global options (-C <dir>, -c <k=v>, --flag[=v]), then push — `git stash push` is not a push.
const TEXT_PUSH = /\bgit((\s+(-C|-c)\s+("[^"\n]*"|'[^'\n]*'|\S+))|\s+--?[\w-]+(=\S+)?)*\s+push\b/;
// Where the folder is not a straight line of `cd`s — a subshell, bash -c, cd -, popd, env -C: every folder the
// command names and the session's own count.
const SCOPED = /[()]|\b(bash|sh|zsh|dash)\s+-c\b|\bpopd\b|\bcd\s+-(\s|;|&|$)|\benv\b[^|;&\n]*\s(-C|--chdir)(\s|=)/;
const NAMED_DIRS = /(?:\bcd|\bpushd|\benv\b[^|;&\n]*?\s(?:-C|--chdir))(?:=|\s+)("[^"]*"|'[^']*'|[^\s;&|)]+)/g;

// `git push` options: a dry run only by its own flag, not by the value of -o (`-o -n` pushes).
function dryRun(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return false;
    if (PUSH_VALUED.has(a)) { i++; continue; }
    if (a === '--dry-run') return true;
    if (/^-[a-zA-Z]+$/.test(a)) for (const ch of a.slice(1)) { if (ch === 'o') break; if (ch === 'n') return true; }
  }
  return false;
}

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');

// A repository folder from --git-dir / GIT_DIR: <repo>/.git → <repo>.
const repoOf = (dir, gitDir) => { const p = path.resolve(dir || '/', gitDir); return path.basename(p) === '.git' ? path.dirname(p) : p; };

// Pushes in the execs: { dirs } — the folders where git may act; null in them — a variable decides.
function pushes(execs, cwd) {
  const res = [];
  let dir = cwd;
  for (const e of execs) {
    const [prog, ...args] = e.argv;
    const dyn = e.dyn || [];
    if (prog === 'cd' || prog === 'pushd') {
      if (!args.length) dir = os.homedir();
      else if (dyn[1] || args[0] === '-') dir = null;
      else if (dir) dir = path.resolve(dir, args[0]);
      continue;
    }
    if (prog === 'popd') { dir = null; continue; }
    if (path.basename(prog || '') !== 'git') continue;
    const dirs = [];
    let at = dir, j = 1;
    const aliases = {};
    const env = e.env || {};
    if (env.GIT_DIR) dirs.push(repoOf(dir, env.GIT_DIR));
    if (env.GIT_WORK_TREE) dirs.push(path.resolve(dir || '/', env.GIT_WORK_TREE));
    while (j < e.argv.length && e.argv[j].startsWith('-')) {
      const w = e.argv[j], next = e.argv[j + 1];
      if (w === '-C') { at = dyn[j + 1] ? null : at && path.resolve(at, next || '.'); j += 2; continue; }
      if (w === '-c' && next) { const m = /^alias\.([^=]+)=(.*)$/.exec(next); if (m) aliases[m[1]] = m[2]; }
      const gd = /^--(git-dir|work-tree)(?:=(.*))?$/.exec(w);
      if (gd) {
        const v = gd[2] !== undefined ? gd[2] : next;
        if (v) dirs.push(gd[1] === 'git-dir' ? repoOf(at, v) : path.resolve(at || '/', v));
        j += gd[2] !== undefined ? 1 : 2;
        continue;
      }
      j += GIT_VALUED.has(w) ? 2 : 1;
    }
    const sub = e.argv[j], rest = e.argv.slice(j + 1);
    const push = sub === 'push' || sub === 'send-pack' || (sub === 'subtree' && rest.includes('push')) ||
      (aliases[sub] !== undefined && /(^|[\s!])push\b/.test(aliases[sub]));
    if (!push || (sub === 'push' && dryRun(rest))) continue;
    res.push({ dirs: [at, ...dirs] });
  }
  return res;
}

function barePush(ev, ctx = {}) {
  if (ev.tool_name !== 'Bash') return null;
  const cmd = ev.tool_input && ev.tool_input.command;
  if (typeof cmd !== 'string' || !/\bpush\b|\bsend-pack\b/.test(cmd)) return null;
  const hub = real(ctx.hub || HUB_ROOT);
  const cwd = real(ev.cwd || process.cwd());
  const { execs, unknown } = executions(cmd, { cwd });
  const found = pushes(execs, cwd);
  const textPush = unknown.length && TEXT_PUSH.test(cmd) && !/--dry-run/.test(cmd);
  let where = null;
  if (found.length || textPush) {
    const cand = found.flatMap((p) => p.dirs.map((d) => (d ? real(d) : cwd)));
    if (textPush || SCOPED.test(cmd)) {
      cand.push(cwd);
      for (const m of cmd.matchAll(NAMED_DIRS)) cand.push(real(path.resolve(cwd, m[1].replace(/^["']|["']$/g, ''))));
    }
    where = cand.find((d) => inside(d, hub)) || null;
  }
  if (!where) return null;
  const rel = path.relative(hub, where) || 'корень хаба';
  return { decision: 'deny', reason: `Хаб (bare-push): голый git push в ${rel} — пушит только диспетчер, скриптом push-slice с ` +
    'воротами: квитанция «готово к пушу» сходится с веткой, parallel-check волны, история (fast-forward, чужие коммиты, ' +
    'имена), рискованный дифф (CI, деплой, зависимости, сеть, секреты) — отдельным согласием. Сессия задачи не пушит: ' +
    `доклад «готово к пушу» диспетчеру. Как звать: \`node ${SCRIPT} --help\`.` };
}

module.exports = { barePush, pushes, dryRun };
