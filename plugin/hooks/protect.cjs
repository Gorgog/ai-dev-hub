// Protection of slice 13: dangerous calls stopped by a mechanism, not by a text. Four mechanisms, one logical handler
// «protect» (modules pretool.d/30..33-*.cjs, records plugin/mechanisms/<id>.json):
//   protect-files — editing an existing .env, a lockfile, a migration already in HEAD (a new migration is fine);
//   inline-script — a script in `node -e "…"` / `python -c "…"` / an unquoted heredoc with escaping the shell rewrites
//                   (backticks, \\, ${…}): deny with the ready command (Write the body to a file, run the file);
//   agent-model   — hub:reviewer launched on a model other than Opus;
//   agent-roles   — tester writes only tests, reviewer and explorer write no files, no agent writes its memory into
//                   the working repository.
// Bash is read by a small shell parser (quotes, $( ), heredocs, redirections), never by a substring of the command.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = path.join(os.tmpdir(), 'hub-scripts');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// ---- shell ---------------------------------------------------------------------------------------------------------

// parseShell(src, cwd) → simple commands in source order, nested $( ), ( ), `…` and <( ) included:
//   { words: [{ v, raw, start, end, expand }], redirs: [{ op, target, start, end }],
//     heredocs: [{ delim, quoted, body, start, end, bodyStart, bodyEnd }], herestrings: [word], cwd, env }
// v — the value without quotes; raw — as typed inside the quotes (backslashes kept); expand — the shell would expand
// it ($, `…`, \ in double quotes or bare). cwd follows `cd` within a sequence and is restored after a subshell; a `cd`
// to a place we cannot name makes it null (relative paths after it are not judged). Arithmetic $(( )) / (( )) is
// opaque, `<` `>` inside [[ ]] are comparisons.
function parseShell(src, cwd = process.cwd()) {
  const s = String(src);
  const out = [];
  const pending = [];
  const cwds = [cwd];
  const vars = {};
  const RED = /(\d*)(<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/y;
  let i = 0;

  const isMeta = (c) => c === undefined || /[\s;&|()<>]/.test(c);

  function readBodies() { // i is right after a newline: bodies of the heredocs opened on the line before
    while (pending.length) {
      const hd = pending.shift();
      hd.bodyStart = i;
      const lines = [];
      for (;;) {
        if (i >= s.length) { hd.bodyEnd = s.length; break; }
        const nl = s.indexOf('\n', i);
        const end = nl === -1 ? s.length : nl;
        const line = s.slice(i, end);
        if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) { hd.bodyEnd = end; i = nl === -1 ? s.length : nl + 1; break; }
        lines.push(line);
        i = nl === -1 ? s.length : nl + 1;
      }
      hd.body = lines.join('\n');
    }
  }

  // A command substitution / subshell starting at i (just past the opening paren), parsed as commands up to ')'.
  function nested() {
    cwds.push(cwds[cwds.length - 1]);
    list(')');
    cwds.pop();
    if (s[i] === ')') i++;
  }

  function skipArith() { // i at the first '(' of $(( or ((: past the matching ))
    let depth = 0;
    do { if (s[i] === '(') depth++; else if (s[i] === ')') depth--; i++; } while (i < s.length && depth > 0);
  }

  function skipBackticks() { // i at the opening backtick
    i++;
    while (i < s.length && s[i] !== '`') i += s[i] === '\\' ? 2 : 1;
    i++;
  }

  function word() {
    const start = i;
    let v = '', raw = '', expand = false;
    while (i < s.length && !isMeta(s[i])) {
      const c = s[i];
      if (c === '\\') {
        if (s[i + 1] === '\n') { i += 2; continue; }
        v += s[i + 1] || ''; raw += c + (s[i + 1] || ''); expand = true; i += 2; continue;
      }
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        const body = s.slice(i + 1, end === -1 ? s.length : end);
        v += body; raw += body; i = end === -1 ? s.length : end + 1; continue;
      }
      if (c === '$' && s[i + 1] === "'") { // $'…' — ANSI-C quoting: backticks and ${ are literal here
        let j = i + 2;
        while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
        const body = s.slice(i + 2, j);
        v += body; raw += body; i = j + 1; continue;
      }
      if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          const d = s[i];
          if (d === '\\') { const n = s[i + 1] || ''; v += '$`"\\\n'.includes(n) ? n : d + n; raw += d + n; expand = true; i += 2; continue; }
          if (d === '$' && s[i + 1] === '(' && s[i + 2] === '(') { const from = i; i++; skipArith(); v += s.slice(from, i); raw += s.slice(from, i); expand = true; continue; }
          if (d === '$' && s[i + 1] === '(') { const from = i; i += 2; nested(); v += s.slice(from, i); raw += s.slice(from, i); expand = true; continue; }
          if (d === '`') { const from = i; skipBackticks(); v += s.slice(from, i); raw += s.slice(from, i); expand = true; continue; }
          if (d === '$') expand = true;
          v += d; raw += d; i++;
        }
        i++;
        continue;
      }
      if (c === '$' && s[i + 1] === '(' && s[i + 2] === '(') { const from = i; i++; skipArith(); v += s.slice(from, i); raw += s.slice(from, i); expand = true; continue; }
      if (c === '$' && s[i + 1] === '(') { const from = i; i += 2; nested(); v += s.slice(from, i); raw += s.slice(from, i); expand = true; continue; }
      if (c === '`') { const from = i; skipBackticks(); v += s.slice(from, i); raw += s.slice(from, i); expand = true; continue; }
      if (c === '$') expand = true;
      v += c; raw += c; i++;
    }
    return { v, raw, start, end: i, expand };
  }

  function list(stop) {
    let cmd = null;
    const begin = () => {
      if (!cmd) { cmd = { words: [], redirs: [], heredocs: [], herestrings: [], cwd: cwds[cwds.length - 1], env: { ...vars } }; out.push(cmd); }
      return cmd;
    };
    const finish = () => {
      if (cmd && cmd.words.length && cmd.words[0].v === 'cd') {
        const to = cmd.words[1] ? expandVars(cmd.words[1].v, cmd.env) : os.homedir();
        if (to === null || (cmd.cwd === null && !path.isAbsolute(to))) cwds[cwds.length - 1] = null;
        else if (!to.startsWith('-')) cwds[cwds.length - 1] = path.resolve(cmd.cwd, to);
      }
      // S=/abs; … "$S/x" — a plain assignment (or export) is remembered for the paths of the next commands.
      if (cmd && cmd.words.length && (cmd.words[0].v === 'export' || programAt(cmd.words) < 0)) {
        for (const w of cmd.words) {
          const m = w.v.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
          if (!m) continue;
          const val = expandVars(m[2], vars);
          if (val === null) delete vars[m[1]]; else vars[m[1]] = val;
        }
      }
      cmd = null;
    };
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '\n') { finish(); i++; readBodies(); continue; }
      if (c === '#' && (!cmd || i === 0 || /\s/.test(s[i - 1]))) { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (c === ')') { if (stop === ')') { finish(); return; } i++; continue; }
      if (c === ';' || c === '|' || (c === '&' && s[i + 1] !== '>')) { finish(); i++; continue; }
      if (c === '(' && s[i + 1] === '(' && !(cmd && cmd.words.length)) { finish(); skipArith(); continue; } // (( x > y ))
      if ((c === '<' || c === '>') && cmd && cmd.words.length && cmd.words[0].v === '[[') { // [[ $a > b ]]
        begin().words.push({ v: c, raw: c, start: i, end: i + 1, expand: false }); i++; continue;
      }
      if (c === '(') {
        if (cmd && cmd.words.length) { i++; continue; } // f() { … } — a function definition
        finish(); i++; nested(); continue;
      }
      if ((c === '<' || c === '>') && s[i + 1] === '(') { i += 2; nested(); continue; } // process substitution
      RED.lastIndex = i;
      const red = RED.exec(s);
      if (red) {
        const opStart = i;
        const op = red[2];
        i += red[0].length;
        while (s[i] === ' ' || s[i] === '\t') i++;
        const w = word();
        const c2 = begin();
        if (op === '<<' || op === '<<-') {
          const hd = { delim: w.v, quoted: /['"\\]/.test(s.slice(w.start, w.end)), strip: op === '<<-', start: opStart, end: w.end, body: '', bodyStart: s.length, bodyEnd: s.length };
          c2.heredocs.push(hd);
          pending.push(hd);
        } else if (op === '<<<') c2.herestrings.push({ ...w, opStart });
        else if ((op === '>&' || op === '<&') && /^(\d+-?|-)$/.test(w.v)) { /* fd duplication */ }
        else c2.redirs.push({ op, target: w.v, start: opStart, end: w.end });
        continue;
      }
      const w = word();
      if (w.end === w.start) { i++; continue; }
      begin().words.push(w);
    }
    finish();
  }

  list(null);
  return out;
}

// $NAME / ${NAME} from the assignments seen so far (HOME from the system), ~ at the start; null when something stays
// unknown — a path we cannot name is not judged.
function expandVars(str, env = {}) {
  let known = true;
  const out = String(str).replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a, b) => {
    const name = a || b;
    const v = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : name === 'HOME' ? os.homedir() : null;
    if (v === null) { known = false; return m; }
    return v;
  });
  if (!known || /[$`]/.test(out)) return null;
  return out.replace(/^~(?=\/|$)/, os.homedir());
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time']);
const WRAPPERS = { env: /^-[iu0]?$|^--/, command: /^-/, exec: /^-/, nohup: null, sudo: /^-/, nice: /^-/, stdbuf: /^-/, timeout: /^-/ };

// Index of the command's program word (past assignments, keywords and wrappers like env/sudo/timeout), or -1.
function programAt(words) {
  let k = 0;
  while (k < words.length) {
    const v = words[k].v;
    if (KEYWORDS.has(v) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) { k++; continue; }
    if (Object.prototype.hasOwnProperty.call(WRAPPERS, v)) {
      k++;
      const flag = WRAPPERS[v];
      while (k < words.length && ((flag && flag.test(words[k].v)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].v))) {
        if (['-n', '-u', '-s', '-k', '-C', '-g', '-o', '-e'].includes(words[k].v) && v !== 'env') k++;
        k++;
      }
      if (v === 'timeout' && k < words.length && /^\d/.test(words[k].v)) k++;
      if (v === 'nice' && k < words.length && /^-?\d+$/.test(words[k].v)) k++;
      continue;
    }
    return k;
  }
  return -1;
}

const nonFlags = (args) => {
  const res = [];
  let dashdash = false;
  for (const a of args) {
    if (!dashdash && a.v === '--') { dashdash = true; continue; }
    if (!dashdash && a.v.startsWith('-') && a.v !== '-') continue;
    res.push(a);
  }
  return res;
};

// git's subcommand word index (past -C <dir>, -c <k=v>, --git-dir=…, --no-pager), or -1.
function gitSub(words, k) {
  let j = k + 1;
  while (j < words.length && words[j].v.startsWith('-')) j += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[j].v) ? 2 : 1;
  return j < words.length ? j : -1;
}

// A path with * or ? in its segments → the existing paths it matches (at most 200), else []. Brackets stay literal:
// [id] / [post-id] are folder names of Next and Nuxt routes far more often than a character class.
function globPaths(abs) {
  let cur = ['/'];
  for (const seg of abs.split('/').filter(Boolean)) {
    if (!/[*?]/.test(seg)) { cur = cur.map((d) => path.join(d, seg)); continue; }
    const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    cur = cur.flatMap((d) => { try { return fs.readdirSync(d).filter((n) => re.test(n)).map((n) => path.join(d, n)); } catch { return []; } }).slice(0, 200);
  }
  return cur.filter((p) => fs.existsSync(p));
}

// Files a command writes or removes: [{ path (absolute), via }]. Paths with an unknown variable or relative to an
// unknown cwd are left out; a glob is expanded over the disk.
function writeTargets(cmd) {
  const res = [];
  const add = (p, via) => {
    const x = p && expandVars(p, cmd.env);
    if (!x || (cmd.cwd === null && !path.isAbsolute(x))) return;
    const abs = path.resolve(cmd.cwd || '/', x);
    if (/[*?]/.test(x)) globPaths(abs).forEach((g) => res.push({ path: g, via }));
    else res.push({ path: abs, via });
  };
  for (const r of cmd.redirs) if (/>|<>/.test(r.op)) add(r.target, `${r.op} ${r.target}`);
  const k = programAt(cmd.words);
  if (k < 0) return res;
  const name = path.basename(cmd.words[k].v);
  const args = cmd.words.slice(k + 1);
  const files = nonFlags(args);
  if (name === 'tee') files.forEach((a) => add(a.v, 'tee'));
  else if (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a.v))) {
    const scripted = args.some((a) => /^(-e|-f|--expression|--file)/.test(a.v));
    const rest = [];
    for (let j = 0; j < args.length; j++) {
      if (/^(-e|-f|--expression|--file)$/.test(args[j].v)) { j++; continue; }
      if (args[j].v.startsWith('-')) continue;
      rest.push(args[j]);
    }
    (scripted ? rest : rest.slice(1)).forEach((a) => add(a.v, 'sed -i'));
  } else if (name === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a.v) && !/^-[IMmx]/.test(a.v))) {
    const rest = [];
    let scripted = false;
    for (let j = 0; j < args.length; j++) {
      if (/^-[a-zA-Z]*[eE]$/.test(args[j].v)) { scripted = true; j++; continue; }
      if (args[j].v.startsWith('-')) continue;
      rest.push(args[j]);
    }
    (scripted ? rest : rest.slice(1)).forEach((a) => add(a.v, 'perl -i'));
  } else if (name === 'cp' || name === 'install' || name === 'ln') {
    const t = args.findIndex((a) => a.v === '-t' || a.v === '--target-directory');
    if (t >= 0 && args[t + 1]) add(args[t + 1].v, name);
    else if (files.length >= 2) add(files[files.length - 1].v, name);
  } else if (name === 'mv') files.forEach((a, n) => add(a.v, n === files.length - 1 ? 'mv →' : 'mv'));
  else if (['rm', 'unlink', 'shred'].includes(name)) files.forEach((a) => add(a.v, name));
  else if (name === 'truncate') nonFlags(args.filter((a, j) => !/^(-s|--size|-r|--reference)$/.test((args[j - 1] || {}).v || ''))).forEach((a) => add(a.v, 'truncate'));
  else if (name === 'dd') args.filter((a) => a.v.startsWith('of=')).forEach((a) => add(a.v.slice(3), 'dd'));
  else if (name === 'git') {
    const j = gitSub(cmd.words, k);
    const gargs = j >= 0 ? cmd.words.slice(j + 1) : [];
    const sub = j >= 0 ? cmd.words[j].v : '';
    const gfiles = nonFlags(gargs);
    if (['rm', 'mv'].includes(sub) && !gargs.some((a) => a.v === '--cached')) {
      gfiles.forEach((a, n) => add(a.v, sub === 'mv' && n === gfiles.length - 1 ? 'git mv →' : `git ${sub}`));
    }
  }
  return res;
}

// Every file a call writes: the edit tools' path, or Bash write targets of every command.
function callTargets(ev) {
  const input = ev.tool_input || {};
  const cwd = ev.cwd || process.cwd();
  if (EDIT_TOOLS.has(ev.tool_name)) {
    const f = input.file_path || input.notebook_path;
    return typeof f === 'string' ? [{ path: path.resolve(cwd, f), via: ev.tool_name }] : [];
  }
  if (ev.tool_name === 'Bash' && typeof input.command === 'string') return parseShell(input.command, cwd).flatMap(writeTargets);
  return [];
}

const realp = (p) => {
  let cur = p;
  const tail = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  try { return path.join(fs.realpathSync.native(cur), ...tail); } catch { return p; }
};

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const gitOut = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: cleanEnv(), timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : null;
};

// ---- protect-files -------------------------------------------------------------------------------------------------

const LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'composer.lock', 'Gemfile.lock', 'go.sum']);

const MIGRATION_DIR = /^(migrations?|migrate)$/i;
const DOC_EXT = /\.(md|markdown|txt|rst|adoc)$/i;

// A file path from the repository root lies in a migrations folder: migration(s)/ anywhere, migrate/ only as Rails'
// db/migrate (cmd/migrate/ of a Go project is code).
function inMigrationDir(rel) {
  const dirs = rel.split(path.sep).slice(0, -1).map((d) => d.toLowerCase());
  return dirs.some((d, i) => /^migrations?$/.test(d) || (d === 'migrate' && dirs[i - 1] === 'db'));
}

// A cheap first look by the path alone; a migration candidate is confirmed by appliedMigration().
function classify(p) {
  const base = path.basename(p);
  if (/^\.env(\.[^/]+)?$/.test(base) && !/\.(example|sample|template|dist|defaults?|schema)$/i.test(base)) return 'env';
  if (LOCKS.has(base)) return 'lock';
  if (p.split(path.sep).some((seg) => MIGRATION_DIR.test(seg))) return 'migration';
  return null;
}

// A migration «applied» = already in HEAD of its repository; a file on disk but not committed is a new one. The
// migrations folder is looked for in the path from the repository root (a folder above the root does not count),
// docs are not migrations; a folder (rm -r db) holds applied ones when HEAD has migration files anywhere under it.
function appliedMigration(p) {
  const isDir = fs.existsSync(p) && fs.statSync(p).isDirectory();
  let dir = isDir ? p : path.dirname(p);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const top = gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return false;
  const rel = path.relative(realp(top), realp(p));
  if (!rel || rel.startsWith('..')) return false;
  if (!isDir && (!inMigrationDir(rel) || DOC_EXT.test(rel))) return false;
  const listed = gitOut(top, ['ls-tree', '-r', '--name-only', 'HEAD', '--', rel]);
  return !!listed && listed.split('\n').some((f) => f && !DOC_EXT.test(f) && inMigrationDir(f));
}

const FILE_REASON = {
  env: (p) => `${p} — .env с секретами не правят (правило 4 хаба). Нужна переменная — назови пользователю строку, он впишет сам; образец — в .env.example.`,
  lock: (p) => `${p} — локфайл не правят руками (правило 4 хаба). Зависимости меняет пакетный менеджер (npm install …) — это «среднее» замка: попроси разрешение.`,
  migration: (p) => `${p} — миграция уже в HEAD, то есть применена (правило 4 хаба). Изменение схемы — новой миграцией новым файлом, по плану, одобренному пользователем.`,
};

function protectFiles(ev) {
  for (const t of callTargets(ev)) {
    // A whole folder removed or moved: protected when applied migrations are under it. The destination folder of mv
    // (via «… →») is a container — moving a new migration into it is fine.
    const isDir = fs.existsSync(t.path) && fs.statSync(t.path).isDirectory();
    if (isDir && t.via.endsWith('→')) continue;
    if (isDir && /^(rm|unlink|shred|mv|git rm|git mv)$/.test(t.via)) {
      if (appliedMigration(t.path)) return { decision: 'deny', reason: `Хаб (protect-files): ${FILE_REASON.migration(`${t.path} (внутри)`)}` };
      continue;
    }
    const kind = classify(t.path);
    if (!kind) continue;
    if (kind === 'migration' ? !appliedMigration(t.path) : !fs.existsSync(t.path)) continue;
    return { decision: 'deny', reason: `Хаб (protect-files): ${FILE_REASON[kind](t.path)}` };
  }
  return null;
}

// ---- inline-script -------------------------------------------------------------------------------------------------

// eval — the flag that takes the script as an argument (what the ready command uses for a heredoc-fed one).
const INTERPS = [
  { re: /^(node|nodejs)$/, ext: '.cjs', eval: '-e', flag: (v) => /^(-e|--eval|-p|--print|-pe)$/.test(v) },
  { re: /^python[\d.]*$/, ext: '.py', eval: '-c', flag: (v) => /^-[A-Za-z]*c$/.test(v) },
  { re: /^perl$/, ext: '.pl', eval: '-e', flag: (v) => /^-[A-Za-z]*[eE]$/.test(v) },
  { re: /^ruby$/, ext: '.rb', eval: '-e', flag: (v) => /^-[A-Za-z]*e$/.test(v) },
];
const CODE_EXT = /\.(c?js|mjs|[cm]?ts|py|rb|pl|sh|bash)$/;
// Escaping the shell itself rewrites — only where it expands (double quotes, a heredoc without quotes): an unescaped
// backtick (a JS template runs as a command), `\\` (collapses to one), `${…}` that is no shell parameter (bad
// substitution). '…' and <<'EOF' reach the interpreter as typed; $VAR in double quotes is mostly meant (a path) — both
// pass. Measured 05.11 on 56k real Bash calls: the strict «any \, ` or ${» would deny 7 % of them, this ~0.2 %.
const hazard = (body, expand) => expand && (/(^|[^\\])`/.test(body) || /\\\\/.test(body)
  || /(^|[^\\])\$\{(?![A-Za-z_][A-Za-z0-9_]*([:#%/^,@-][^}]*)?\})/.test(body));

function applyEdits(s, edits) {
  let res = s;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) res = res.slice(0, e.start) + e.text + res.slice(e.end);
  return res;
}

function scriptFile(body, ext) {
  return path.join(SCRIPTS_DIR, crypto.createHash('sha1').update(body).digest('hex').slice(0, 10) + ext);
}

const INLINE_WHY = 'в двойных кавычках и в heredoc без кавычек shell сам переписывает скрипт: обратная кавычка запускает команду, `\\\\` схлопывается в `\\`, `${…}` — подстановка (уроки «heredoc / node -e»).';

function inlineScript(ev) {
  const input = ev.tool_input || {};
  if (ev.tool_name !== 'Bash' || typeof input.command !== 'string') return null;
  const src = input.command;
  for (const cmd of parseShell(src, ev.cwd || process.cwd())) {
    const k = programAt(cmd.words);
    if (k < 0) continue;
    const name = path.basename(cmd.words[k].v);
    const interp = INTERPS.find((x) => x.re.test(name));
    if (interp) {
      const args = cmd.words.slice(k + 1);
      let flagAt = -1, scriptArg = null;
      for (let j = 0; j < args.length; j++) {
        const v = args[j].v;
        if (v === '--') { scriptArg = args[j + 1] || null; break; }
        if (!v.startsWith('-') || v === '-') { scriptArg = args[j]; break; }
        if (interp.flag(v) && args[j + 1]) { flagAt = j; break; }
      }
      // The ready command keeps the interpreter, its flags, the cwd (require / import from it) and stdin: only the body
      // moves to a file and comes back as "$(cat FILE)" — the shell does not rewrite a substitution's result.
      let body = null, expand = false, file = null;
      const edits = [];
      const ext = name.startsWith('node') && args.some((a) => a.v === '--input-type=module') ? '.mjs' : interp.ext;
      if (flagAt >= 0) {
        const b = args[flagAt + 1];
        body = b.raw; expand = b.expand;
        file = scriptFile(body, ext);
        edits.push({ start: b.start, end: b.end, text: `"$(cat ${file})"` });
      } else if ((cmd.heredocs.length || cmd.herestrings.length) && (!scriptArg || scriptArg.v === '-')) {
        const hd = cmd.heredocs[cmd.heredocs.length - 1];
        const hs = cmd.herestrings[cmd.herestrings.length - 1];
        if (hd) { body = hd.body; expand = !hd.quoted; } else { body = hs.raw; expand = hs.expand; }
        file = scriptFile(body, ext);
        const evalArg = `${interp.eval} "$(cat ${file})"`;
        if (hd) {
          let st = hd.start;
          while (st > 0 && (src[st - 1] === ' ' || src[st - 1] === '\t')) st--;
          edits.push({ start: st, end: hd.end, text: '' });
          if (src[hd.bodyStart - 1] === '\n' && hd.bodyStart < src.length) edits.push({ start: hd.bodyStart - 1, end: hd.bodyEnd, text: '' });
        } else {
          let st = hs.opStart;
          while (st > 0 && (src[st - 1] === ' ' || src[st - 1] === '\t')) st--;
          edits.push({ start: st, end: hs.end, text: '' });
        }
        if (scriptArg) edits.push({ start: scriptArg.start, end: scriptArg.end, text: evalArg });
        else {
          let last = cmd.words[k];
          for (const a of args) { if (a.v.startsWith('-') && a.v !== '-') last = a; else break; }
          edits.push({ start: last.end, end: last.end, text: ` ${evalArg}` });
        }
      }
      if (body !== null && hazard(body, expand)) {
        const ready = applyEdits(src, edits).trim();
        return { decision: 'deny', reason: `Хаб (inline-script): ${INLINE_WHY} Запиши тело скрипта инструментом Write в ${file} — как задумано, без экранирования под shell — и выполни Bash: \`${ready}\`. Можно файл в scratchpad сессии — тогда тот же путь и в команде.` };
      }
      continue;
    }
    // Code written to a file through a heredoc: cat > fix.py <<'EOF' … — Write straight into that file.
    if ((name === 'cat' || name === 'tee') && cmd.heredocs.length) {
      const target = writeTargets(cmd).find((t) => CODE_EXT.test(t.path));
      const hd = cmd.heredocs[cmd.heredocs.length - 1];
      if (target && hazard(hd.body, !hd.quoted)) {
        return { decision: 'deny', reason: `Хаб (inline-script): ${INLINE_WHY} Код в файл — инструментом Write прямо в ${target.path} (тело — как задумано, без экранирования под shell), не heredoc в Bash.` };
      }
    }
  }
  return null;
}

// ---- agent-model ---------------------------------------------------------------------------------------------------

const roleOf = (type) => String(type || '').split(':').pop();

// A model family by name, Latin or Cyrillic, as a person writes it in chat.
const FAMILIES = { sonnet: /sonnet|сон+ет/i, fable: /fable|ф[еэ]йбл/i, haiku: /haiku|хайку/i };
const TRANSCRIPT_CAP = 32 * 1024 * 1024;
const NEGATION = /(^|[^а-яёa-z])(не|нет|ни|без|кроме|никак[а-яё]*|not|no|without|except|don'?t)(?![а-яёa-z])/i;
const REVIEW = /ревью|review/i;

// Named = a mention whose clause (between , . ; : ! ? ( ) or line breaks) is about the review and has no negation on
// either side: «ревью на sonnet» names it; «только не на sonnet — на opus», «sonnet не надо», «никакого sonnet»,
// «пусть исследует sonnet-агент» do not.
function named(text, re) {
  const g = new RegExp(re.source, 'gi');
  const isCut = (c) => ',.;:!?()\n'.includes(c);
  let m;
  while ((m = g.exec(text))) {
    let a = m.index, b = m.index + m[0].length;
    while (a > 0 && !isCut(text[a - 1])) a--;
    while (b < text.length && !isCut(text[b])) b++;
    const clause = text.slice(a, b);
    if (REVIEW.test(clause) && !NEGATION.test(clause)) return true;
  }
  return false;
}

// The text of the person's last message in the session journal, system-reminder blocks cut out; null when the journal
// is missing or unreadable. «The person» = origin.kind human: tool results, other sessions' messages (peer), task
// notifications and hook injections are not them.
function lastHumanText(file) {
  if (typeof file !== 'string' || !file) return null;
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TRANSCRIPT_CAP);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"human"')) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== 'user' || o.isMeta || !o.origin || o.origin.kind !== 'human') continue;
    const c = o.message && o.message.content;
    const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  }
  return null;
}

// Rule 8: the reviewer runs on Opus (reviewer.md); another model only when the person named it in their last message.
function agentModel(ev) {
  if (ev.tool_name !== 'Agent' && ev.tool_name !== 'Task') return null;
  const input = ev.tool_input || {};
  const model = String(input.model || '');
  if (roleOf(input.subagent_type) !== 'reviewer' || !model || /opus/i.test(model)) return null;
  const family = Object.keys(FAMILIES).find((f) => model.toLowerCase().includes(f));
  const re = family ? FAMILIES[family] : new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const said = lastHumanText(ev.transcript_path);
  if (said !== null && named(said, re)) return null;
  return { decision: 'deny', reason: `Хаб (agent-model): ревьюер — только на Opus (правило 8 хаба), модель задаёт reviewer.md. Повтори вызов ${ev.tool_name} с теми же полями без model (subagent_type: "${input.subagent_type}"), сейчас model: "${input.model}"; другая модель — только если пользователь назовёт её сам${said === null ? ' (журнал сессии не прочитан)' : ''}.` };
}

// ---- agent-roles ---------------------------------------------------------------------------------------------------

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e|__fixtures__|fixtures|__snapshots__|__mocks__|testdata)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.snap$/i;
const GIT_WRITES = new Set(['add', 'commit', 'reset', 'checkout', 'switch', 'restore', 'stash', 'merge', 'rebase', 'cherry-pick',
  'revert', 'rm', 'mv', 'clean', 'apply', 'am', 'push', 'pull', 'tag', 'branch', 'worktree', 'notes', 'update-ref', 'gc', 'init']);
const GIT_READ_FORMS = { stash: /^(list|show)$/, worktree: /^list$/, notes: /^(list|show)$/ };
const TAG_LIST = /^(-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--sort|--format|--column)(=|$)/;

// A git command that changes a repository: { what: 'git stash', dir } — dir is where it acts (cwd, -C, the path of
// init), null when a variable in it is unknown. branch/tag only with arguments that change.
function gitWrite(cmd) {
  const k = programAt(cmd.words);
  if (k < 0 || path.basename(cmd.words[k].v) !== 'git') return null;
  const j = gitSub(cmd.words, k);
  if (j < 0) return null;
  const sub = cmd.words[j].v;
  const rest = cmd.words.slice(j + 1).map((w) => w.v);
  if (!GIT_WRITES.has(sub)) return null;
  if (GIT_READ_FORMS[sub] && rest.length && GIT_READ_FORMS[sub].test(rest[0])) return null;
  if (sub === 'notes' && !rest.length) return null;
  if (sub === 'branch' && !rest.some((a) => /^-[dDmMcCf]$|^--(delete|move|copy|force|set-upstream-to)/.test(a))) return null;
  if (sub === 'tag' && (rest.some((a) => TAG_LIST.test(a)) || !rest.length)) return null;
  if (sub === 'apply' && rest.some((a) => /^--(check|stat|numstat|summary)$/.test(a)) && !rest.includes('--apply')) return null;
  let dir = cmd.cwd;
  for (let m = k + 1; m < j && dir; m++) {
    if (cmd.words[m].v === '-C' && cmd.words[m + 1]) { const d = expandVars(cmd.words[m + 1].v, cmd.env); dir = d === null ? null : path.resolve(dir, d); m++; }
  }
  const initArgs = cmd.words.slice(j + 1).filter((w, m, all) => !/^(-b|--initial-branch|--template|--separate-git-dir|--object-format|--ref-format)$/.test((all[m - 1] || {}).v || ''));
  const target = sub === 'init' && nonFlags(initArgs)[0];
  if (target && dir) { const d = expandVars(target.v, cmd.env); dir = d === null ? null : path.resolve(dir, d); }
  return { what: `git ${sub}`, dir };
}

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');

const ROLE_TEXT = {
  reviewer: 'ревьюер не пишет файлов и не меняет git (роль hub:reviewer): находку и предлагаемую правку — в отчёт, временное — в /tmp',
  explorer: 'разведчик только читает (роль hub:explorer): выводы — в отчёт, временное — в /tmp',
  tester: 'тестировщик пишет только тесты (роль hub:tester): правка рабочего кода — находка в отчёт',
};

function agentRoles(ev, ctx = {}) {
  const role = roleOf(ev.agent_type);
  const targets = callTargets(ev).map((t) => ({ ...t, real: realp(t.path) }));
  // Project and local agent memory lives in a repository (<repo>/.claude/agent-memory[-local]); the user scope
  // (~/.claude/agent-memory) is not a repository, and removing the folder is cleaning up, not writing.
  const home = realp(path.join(os.homedir(), '.claude'));
  const mem = targets.find((t) => /(^|\/)\.claude\/agent-memory(-local)?(\/|$)/.test(t.real) && !inside(t.real, home)
    && !/^(rm|unlink|shred|git rm)$/.test(t.via));
  if (mem) return { decision: 'deny', reason: `Хаб (agent-roles): ${mem.path} — агенты не пишут память в рабочий репозиторий (.claude/agent-memory): урок — строкой «Предлагаю в errors.md» в отчёте.` };
  if (!ROLE_TEXT[role]) return null;

  const hub = ctx.hub ? realp(ctx.hub) : null;
  const hubMem = hub && targets.find((t) => t.real.startsWith(`${hub}/projects/`) && t.real.slice(hub.length + 10).split('/')[1] === 'memory');
  if (hubMem) return { decision: 'deny', reason: `Хаб (agent-roles): ${hubMem.path} — агенты не пишут память проекта: урок — строкой «Предлагаю в errors.md» в отчёте, запишет основная сессия.` };

  const why = ROLE_TEXT[role];
  const cwd = ev.cwd || process.cwd();
  const command = ev.tool_name === 'Bash' && (ev.tool_input || {}).command;
  const gits = typeof command === 'string' ? parseShell(command, cwd).map(gitWrite).filter((g) => g && g.dir) : [];
  // gitWrite resolves -C / init paths from cmd.cwd; with an unknown cwd only absolute ones survive (dir non-null).
  if (!targets.length && !gits.length) return null;
  // The working repository is the session's one (its git top, else cwd); the scratchpad, /tmp and a scratch repo
  // there are the agent's own — notes and probes are fine.
  const root = realp(gitOut(cwd, ['rev-parse', '--show-toplevel']) || cwd);
  const isTest = (t) => TEST_PATH.test(path.relative(root, t.real));
  const bad = targets.find((t) => inside(t.real, root) && !(role === 'tester' && isTest(t)));
  if (bad) return { decision: 'deny', reason: `Хаб (agent-roles): ${why}; запись в ${bad.path} (${bad.via})${role === 'tester' ? ' — не тест' : ''}.` };
  const g = gits.find((x) => inside(realp(x.dir), root));
  if (g) return { decision: 'deny', reason: `Хаб (agent-roles): ${why}; ${g.what} меняет рабочий репозиторий ${root}.` };
  return null;
}

module.exports = { SCRIPTS_DIR, parseShell, writeTargets, classify, gitWrite, protectFiles, inlineScript, agentModel, agentRoles };
