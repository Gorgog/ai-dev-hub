#!/usr/bin/env node
// Local settings the hub needs on this machine and in this project — what is missing, and one setting at a time.
// usage:
//   node setup.cjs check [--json]   what is set and what is missing here («не хватает N настроек»)
//   node setup.cjs apply <id>       set one setting (backup of the settings file first; a set one — «уже стоит»)
// Machine: bash-cwd (CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1, probe P1: no cwd drift for the session and its
// subagents), journal-retention (session journals ≥ 365 days), plugin-version (installed hub@hub = the hub's main),
// status-line (an own status line is the user's choice), allowlist (approved entries of allowlist.json). Project (cwd
// inside projects/<name>/ of the hub): auto-memory (autoMemoryDirectory → projects/<name>/memory/auto/ in
// .claude/settings.local.json of repo/, excluded from git locally; a worktree is «?» — wt-new.sh is the place); in a
// project with the dispatcher's board (memory/dispatch.md) — dispatch-profile, dispatch-rules, checks-json: written by
// hand from templates/project (a copy of the template would switch the lock on with another stack's rules), apply only
// says how — code 4.
// ~/.claude is CLAUDE_CONFIG_DIR when set; the hub — lib/hub.cjs (AI_DEV_HUB, the marketplace `hub`). The SessionStart
// module sessionstart.d/20-setup.cjs runs check(); /hub:setup runs apply for each missing one, one Bash call each.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { hubRoot, findProject } = require('../../../hooks/lib/hub.cjs');

const RETENTION = 365;
const ENV = 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR';
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const allowFile = () => process.env.HUB_SETUP_ALLOWLIST || path.join(__dirname, '..', 'allowlist.json');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

class Refused extends Error {}
class ByHand extends Error {}

// A settings file: {} when absent; unreadable — refused, never overwritten.
function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
  } catch { /* below */ }
  throw new Refused(`${file} не разбирается — поправь руками, setup его не перезапишет`);
}

// Change a settings file through fn(settings): unchanged — nothing written; changed — backup, then temp + rename on
// the real path (a symlinked settings.json from dotfiles stays a link). Changed by someone else meanwhile (Claude Code
// itself, another session) — refused, run again: a lost write would come back as «missing» anyway.
function editSettings(link, fn) {
  let file = link;
  try { file = fs.realpathSync.native(link); } catch { /* not there yet */ }
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const s = readSettings(file);
  const before = JSON.stringify(s);
  fn(s);
  if (JSON.stringify(s) === before) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let bak = null;
  if (raw !== null) { bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`; fs.writeFileSync(bak, raw); }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) !== raw) {
    fs.rmSync(tmp, { force: true });
    throw new Refused(`${file} изменился, пока его правили — повтори apply`);
  }
  fs.renameSync(tmp, file);
  return bak || 'новый файл';
}

function readAllow() {
  try {
    const a = JSON.parse(fs.readFileSync(allowFile(), 'utf8')).allow;
    return Array.isArray(a) ? a.map((e) => (typeof e === 'string' ? e : e && e.rule)).filter((r) => typeof r === 'string' && r) : [];
  } catch { return []; }
}

// The repo or worktree root of cwd when it lies inside the project (not the hub's own checkout around it).
function projectRoot(cwd, proj) {
  const top = tryGit(cwd, 'rev-parse', '--show-toplevel');
  if (!top) return null;
  let real = top; try { real = fs.realpathSync.native(top); } catch { /* as is */ }
  return real.startsWith(proj.dir + '/') ? real : null;
}

// Every setting: { id, title, scope, ok: true | false | null (cannot tell here), have, want, apply() }.
function settingsList({ cwd = process.cwd(), hub = hubRoot() } = {}) {
  const dir = claudeDir();
  const file = path.join(dir, 'settings.json');
  let s = {}, broken = null;
  try { s = readSettings(file); } catch (e) { broken = e.message; }
  const list = [];
  const add = (c) => list.push(c);
  const machine = (id, title, ok, have, want, fn) => add({ id, title, scope: 'machine', ok: broken ? null : ok, have: broken || have, want,
    apply: () => editSettings(file, fn) });

  const env = s.env && typeof s.env === 'object' ? s.env : {};
  machine('bash-cwd', 'рабочая папка Bash держится (P1)', env[ENV] === '1', env[ENV] ? `${ENV}=${env[ENV]}` : 'не задана', `${ENV}=1`,
    (x) => { x.env = { ...(x.env && typeof x.env === 'object' ? x.env : {}), [ENV]: '1' }; });

  const keep = (v) => Number.isFinite(v) && v >= RETENTION;
  machine('journal-retention', 'срок хранения журналов сессий', keep(s.cleanupPeriodDays) && keep(s.desktopSessionCleanupPeriodDays),
    `cleanupPeriodDays=${s.cleanupPeriodDays ?? '—'}, desktopSessionCleanupPeriodDays=${s.desktopSessionCleanupPeriodDays ?? '—'}`, `обе ≥ ${RETENTION}`,
    (x) => { for (const k of ['cleanupPeriodDays', 'desktopSessionCleanupPeriodDays']) if (!keep(x[k])) x[k] = RETENTION; });

  const line = path.join(hub, 'plugin', 'skills', 'setup', 'scripts', 'statusline.cjs');
  const wantLine = `node "${line}"`;
  const sl = s.statusLine && typeof s.statusLine === 'object' ? s.statusLine : null;
  // Ours — any command that runs statusline.cjs of the hub (a symlinked hub path is still ours); another one — the user's.
  const own = sl && !/setup[\\/]+scripts[\\/]+statusline\.cjs/.test(String(sl.command || ''));
  machine('status-line', 'строка состояния хаба', !!sl && (own || sl.command === wantLine),
    sl ? `${String(sl.command || sl.type)}${own ? ' (своя — не трогаю)' : ''}` : 'нет', wantLine,
    (x) => { if (!own) x.statusLine = { type: 'command', command: wantLine, padding: 0 }; });

  const approved = readAllow();
  const allow = s.permissions && Array.isArray(s.permissions.allow) ? s.permissions.allow : [];
  const lack = approved.filter((r) => !allow.includes(r));
  machine('allowlist', 'одобренные разрешения (allowlist.json)', !lack.length, lack.length ? `нет: ${lack.join(', ')}` : `${approved.length} из ${approved.length}`,
    `${approved.length} записей`, (x) => {
      x.permissions = x.permissions && typeof x.permissions === 'object' ? x.permissions : {};
      const cur = Array.isArray(x.permissions.allow) ? x.permissions.allow : [];
      x.permissions.allow = [...cur, ...approved.filter((r) => !cur.includes(r))];
    });

  // The installed copy (skills, agents) must be the hub's main: hooks run from the working tree anyway (P17).
  const main = tryGit(hub, 'rev-parse', '--verify', '-q', 'refs/heads/main');
  let installed = [];
  try { installed = JSON.parse(fs.readFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins['hub@hub'] || []; } catch { /* none */ }
  const shas = installed.map((p) => p && p.gitCommitSha).filter(Boolean);
  add({ id: 'plugin-version', title: 'установленный плагин hub@hub = main хаба', scope: 'machine', ok: main ? shas.includes(main) : null,
    have: shas.length ? shas.map((x) => x.slice(0, 7)).join(', ') : 'не установлен', want: main ? main.slice(0, 7) : 'main хаба не найден',
    apply: () => updatePlugin(hub) });

  const proj = findProject(cwd, hub);
  if (!proj) return list;
  const tmpl = path.join(hub, 'templates', 'project');
  const board = fs.existsSync(path.join(proj.dir, 'memory', 'dispatch.md'));
  const byHand = (id, title, name, from) => {
    const dest = path.join(proj.dir, name);
    const text = read(dest);
    const copy = text !== null && text === read(path.join(tmpl, from));
    add({ id, title, scope: 'project', ok: !board ? null : text !== null && !copy,
      have: text === null ? 'нет' : copy ? 'копия образца — не дописан' : name,
      want: board ? `${name} под проект (образец — templates/project/${from})` : 'не нужен: у проекта нет доски диспетчера',
      apply: () => { throw new ByHand(`${id}: пишется руками с пользователем — образец ${path.join(tmpl, from)} → ${dest}, поправить под стек проекта`); } });
  };
  byHand('dispatch-profile', 'профиль диспетчера проекта', 'dispatch-profile.md', 'dispatch-profile.md');
  byHand('dispatch-rules', 'правила замка проекта', 'dispatch-rules.json', 'dispatch-rules.example.json');
  byHand('checks-json', 'проверки проекта (скилл checks)', 'checks.json', 'checks.example.json');

  const root = projectRoot(cwd, proj);
  const auto = path.join(proj.dir, 'memory', 'auto') + '/';
  if (root) {
    const local = path.join(root, '.claude', 'settings.local.json');
    const worktree = root.startsWith(path.join(proj.dir, 'worktrees') + '/');
    let cur = null, bad = null;
    try { cur = readSettings(local).autoMemoryDirectory; } catch (e) { bad = e.message; }
    const ok = bad ? null : cur === auto ? true : worktree ? null : false;
    add({ id: 'auto-memory', title: 'автопамять Claude Code — в память проекта', scope: 'project', ok,
      have: bad || (cur ? cur : worktree ? 'worktree: по умолчанию — ставит wt-new.sh или apply здесь' : 'по умолчанию (~/.claude/projects/…)'),
      want: auto, apply: () => {
        excludeLocally(root, '.claude/settings.local.json');
        const done = editSettings(local, (x) => { x.autoMemoryDirectory = auto; });
        fs.mkdirSync(auto, { recursive: true });
        return done;
      } });
  }
  return list;
}

// The file stays out of the client's git: .git/info/exclude (common dir for a worktree), never .gitignore.
function excludeLocally(root, rel) {
  if (tryGit(root, 'check-ignore', '-q', rel) !== null) return;
  const ex = path.resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude'));
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const text = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  fs.appendFileSync(ex, `${text && !text.endsWith('\n') ? '\n' : ''}/${rel}\n`);
}

// As install.cjs: update the marketplace and the plugin; a machine without the marketplace — add and install.
function updatePlugin(hub) {
  const cli = (args) => spawnSync('claude', args, { encoding: 'utf8', timeout: 120000 });
  const text = (r) => `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`.trim();
  let m = cli(['plugin', 'marketplace', 'update', 'hub']);
  let next = ['plugin', 'update', 'hub@hub'];
  if (m.status !== 0 && /not found/i.test(text(m))) { m = cli(['plugin', 'marketplace', 'add', hub]); next = ['plugin', 'install', 'hub@hub']; }
  const u = m.status === 0 ? cli(next) : m;
  if (u.status !== 0) throw new Refused(`claude CLI: ${text(u).split('\n').pop() || 'не запустился'} — вручную: claude plugin marketplace update hub && claude plugin update hub@hub`);
  return `claude ${next.join(' ')}: ${text(u).split('\n').pop()} — новые сессии возьмут новую версию`;
}

const check = (opts) => settingsList(opts);
const missingOf = (list) => list.filter((c) => c.ok === false);
const summary = (list) => `не хватает ${missingOf(list).length} настроек`;

function main(argv) {
  const [cmd, id] = argv;
  if (cmd === 'check') {
    const list = check();
    if (argv.includes('--json')) { console.log(JSON.stringify(list.map(({ apply, ...c }) => c), null, 1)); return 0; }
    for (const c of list) console.log(`${c.ok === true ? '✓' : c.ok === false ? '✗' : '?'} ${c.id} — ${c.title}: ${c.have}${c.ok === false ? ` → ${c.want}` : ''}`);
    const n = missingOf(list).length;
    console.log(`Хаб: ${summary(list)}${n ? ' — /hub:setup ставит каждую с подтверждением' : ''}`);
    return 0;
  }
  if (cmd === 'apply' && id) {
    const c = check().find((x) => x.id === id);
    if (!c) { console.error(`нет настройки «${id}» здесь (setup.cjs check — список)`); return 2; }
    if (c.ok === true) { console.log(`${id}: уже стоит (${c.have})`); return 0; }
    if (c.ok === null && c.scope === 'project' && c.id !== 'auto-memory') { console.log(`${id}: здесь не нужен — ${c.want}`); return 0; }
    const done = c.apply();
    console.log(done ? `${id}: поставлено → ${c.want} (${done})` : `${id}: уже стоит`);
    return 0;
  }
  console.error('usage: setup.cjs check [--json] | apply <id>');
  return 2;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (e instanceof ByHand) { console.log(e.message); process.exitCode = 4; } else {
      console.error(e instanceof Refused ? e.message : `setup: ${String(e && e.stack || e)}`);
      process.exitCode = 3;
    }
  }
}

module.exports = { check, summary, missingOf };
