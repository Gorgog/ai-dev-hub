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
//     heredocs: [{ delim, quoted, body, start, end, bodyStart, bodyEnd }], herestrings: [word], cwd }
// v — the value without quotes; raw — as typed inside the quotes (backslashes kept); expand — the shell would expand
// it ($, `…`, \ in double quotes or bare). cwd follows `cd` within a sequence and is restored after a subshell.
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
      if (c === '$' && s[i + 1] === "'") { // $'…' — ANSI-C quoting, escapes are the shell's
        let j = i + 2;
        while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
        const body = s.slice(i + 2, j);
        v += body; raw += body; expand = true; i = j + 1; continue;
      }
      if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          const d = s[i];
          if (d === '\\') { const n = s[i + 1] || ''; v += '$`"\\\n'.includes(n) ? n : d + n; raw += d + n; expand = true; i += 2; continue; }
          if (d === '$' && s[i + 1] === '(') { const from = i; i += 2; nested(); v += s.slice(from, i); raw += s.slice(from, i); expand = true; continue; }
          if (d === '`') { const from = i; skipBackticks(); v += s.slice(from, i); raw += s.slice(from, i); expand = true; continue; }
          if (d === '$') expand = true;
          v += d; raw += d; i++;
        }
        i++;
        continue;
      }
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
        if (to && !to.startsWith('-')) cwds[cwds.length - 1] = path.resolve(cmd.cwd, to);
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

// Files a command writes or removes: [{ path (absolute), via }].
function writeTargets(cmd) {
  const res = [];
  const add = (p, via) => {
    const x = p && expandVars(p, cmd.env);
    if (x && !/[*?]/.test(x)) res.push({ path: path.resolve(cmd.cwd, x), via });
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
  } else if (name === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a.v))) {
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
  } else if (name === 'mv') files.forEach((a) => add(a.v, 'mv'));
  else if (['rm', 'unlink', 'shred'].includes(name)) files.forEach((a) => add(a.v, name));
  else if (name === 'truncate') nonFlags(args.filter((a, j) => !/^(-s|--size|-r|--reference)$/.test((args[j - 1] || {}).v || ''))).forEach((a) => add(a.v, 'truncate'));
  else if (name === 'dd') args.filter((a) => a.v.startsWith('of=')).forEach((a) => add(a.v.slice(3), 'dd'));
  else if (name === 'git') {
    const j = gitSub(cmd.words, k);
    if (j >= 0 && ['rm', 'mv'].includes(cmd.words[j].v)) nonFlags(cmd.words.slice(j + 1)).forEach((a) => add(a.v, `git ${cmd.words[j].v}`));
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

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const gitOut = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: cleanEnv(), timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : null;
};

// ---- protect-files -------------------------------------------------------------------------------------------------

const LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'composer.lock', 'Gemfile.lock', 'go.sum']);

function classify(p) {
  const base = path.basename(p);
  if (/^\.env(\.[^/]+)?$/.test(base) && !/\.(example|sample|template|dist|defaults?|schema)$/i.test(base)) return 'env';
  if (LOCKS.has(base)) return 'lock';
  if (path.dirname(p).split(path.sep).some((seg) => /^migrations?$/i.test(seg))) return 'migration';
  return null;
}

// A migration «applied» = already in HEAD of its repository; a file on disk but not committed is a new one.
function inHead(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) return false;
  return gitOut(dir, ['cat-file', '-e', `HEAD:./${path.basename(p)}`]) !== null;
}

const FILE_REASON = {
  env: (p) => `${p} — .env с секретами не правят (правило 4 хаба). Нужна переменная — назови пользователю строку, он впишет сам; образец — в .env.example.`,
  lock: (p) => `${p} — локфайл не правят руками (правило 4 хаба). Зависимости меняет пакетный менеджер (npm install …) — это «среднее» замка: попроси разрешение.`,
  migration: (p) => `${p} — миграция уже в HEAD, то есть применена (правило 4 хаба). Изменение схемы — новой миграцией новым файлом, по плану, одобренному пользователем.`,
};

function protectFiles(ev) {
  for (const t of callTargets(ev)) {
    const kind = classify(t.path);
    if (!kind) continue;
    if (kind === 'migration' ? !inHead(t.path) : !fs.existsSync(t.path)) continue;
    return { decision: 'deny', reason: `Хаб (protect-files): ${FILE_REASON[kind](t.path)}` };
  }
  return null;
}

// ---- inline-script -------------------------------------------------------------------------------------------------

const INTERPS = [
  { re: /^(node|nodejs)$/, ext: '.cjs', flag: (v) => /^(-e|--eval|-p|--print|-pe)$/.test(v) },
  { re: /^python[\d.]*$/, ext: '.py', flag: (v) => /^-[A-Za-z]*c$/.test(v) },
  { re: /^perl$/, ext: '.pl', flag: (v) => /^-[A-Za-z]*[eE]$/.test(v) },
  { re: /^ruby$/, ext: '.rb', flag: (v) => /^-[A-Za-z]*e$/.test(v) },
];
const CODE_EXT = /\.(c?js|mjs|[cm]?ts|py|rb|pl|sh|bash)$/;
// Escaping the shell itself rewrites — only where it expands (double quotes, a heredoc without quotes): an unescaped
// backtick (a JS template runs as a command), `\\` (collapses to one), `${…}` that is no shell parameter (bad
// substitution). '…' and <<'EOF' reach the interpreter as typed; $VAR in double quotes is mostly meant (a path) — both
// pass. Measured 05.11 on 56k real Bash calls: the strict «any \, ` or ${» would deny 7 % of them, this ~0.2 %.
const hazard = (body, expand) => expand && (/(^|[^\\])`/.test(body) || /\\\\/.test(body)
  || /\$\{(?![A-Za-z_][A-Za-z0-9_]*([:#%/^,@-][^}]*)?\})/.test(body));

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
      let body = null, expand = false, edits = [], note = '';
      let ext = interp.ext;
      if (name.startsWith('node') && (args.some((a) => a.v === '--input-type=module'))) ext = '.mjs';
      if (flagAt >= 0) {
        const f = args[flagAt], b = args[flagAt + 1];
        body = b.raw; expand = b.expand;
        const file = scriptFile(body, ext);
        const single = /^(-e|--eval|-c|-p|--print|-pe)$/.test(f.v) || (interp.ext !== '.cjs' && f.v.length === 2);
        edits.push({ start: f.start, end: b.end, text: single ? file : `${f.v.slice(0, -1)} ${file}` });
        if (name.startsWith('node') && /p/.test(f.v)) note = ' Вывод результата (-p) — console.log в скрипте.';
      } else if ((cmd.heredocs.length || cmd.herestrings.length) && (!scriptArg || scriptArg.v === '-')) {
        const hd = cmd.heredocs[cmd.heredocs.length - 1];
        const hs = cmd.herestrings[cmd.herestrings.length - 1];
        if (hd) { body = hd.body; expand = !hd.quoted; } else { body = hs.raw; expand = hs.expand; }
        if (name.startsWith('node') && /^\s*(import|export)\s/m.test(body)) ext = '.mjs';
        const file = scriptFile(body, ext);
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
        if (scriptArg) edits.push({ start: scriptArg.start, end: scriptArg.end, text: file });
        else {
          let last = cmd.words[k];
          for (const a of args) { if (a.v.startsWith('-') && a.v !== '-') last = a; else break; }
          edits.push({ start: last.end, end: last.end, text: ` ${file}` });
        }
      }
      if (body !== null && hazard(body, expand)) {
        const file = edits.find((e) => e.text.includes(SCRIPTS_DIR)).text.trim().split(' ').pop();
        const ready = applyEdits(src, edits).trim();
        return { decision: 'deny', reason: `Хаб (inline-script): ${INLINE_WHY} Запиши тело скрипта инструментом Write в ${file} — как задумано, без экранирования под shell — и выполни Bash: \`${ready}\`.${note} Можно файл в scratchpad сессии — тогда тот же путь и в команде.` };
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

function agentModel(ev) {
  if (ev.tool_name !== 'Agent' && ev.tool_name !== 'Task') return null;
  const input = ev.tool_input || {};
  if (roleOf(input.subagent_type) !== 'reviewer' || !input.model || /opus/i.test(String(input.model))) return null;
  return { decision: 'deny', reason: `Хаб (agent-model): ревьюер — только на Opus (правило 8 хаба), модель задаёт reviewer.md. Повтори вызов ${ev.tool_name} с теми же полями без model (subagent_type: "${input.subagent_type}"), сейчас model: "${input.model}".` };
}

// ---- agent-roles ---------------------------------------------------------------------------------------------------

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e|__fixtures__|fixtures|__snapshots__|__mocks__|testdata)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.snap$/i;
const GIT_WRITES = new Set(['add', 'commit', 'reset', 'checkout', 'switch', 'restore', 'stash', 'merge', 'rebase', 'cherry-pick',
  'revert', 'rm', 'mv', 'clean', 'apply', 'am', 'push', 'pull', 'tag', 'branch', 'worktree', 'notes', 'update-ref', 'gc', 'init']);
const GIT_READ_FORMS = { stash: /^(list|show)$/, worktree: /^list$/, notes: /^(list|show)$/ };

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
  if (sub === 'branch' && !rest.some((a) => /^-[dDmMcCf]$|^--(delete|move|copy|force|set-upstream-to)/.test(a))) return null;
  if (sub === 'tag' && !rest.some((a) => !a.startsWith('-')) && !rest.some((a) => /^-[dfas]$/.test(a))) return null;
  let dir = cmd.cwd;
  for (let m = k + 1; m < j && dir; m++) {
    if (cmd.words[m].v === '-C' && cmd.words[m + 1]) { const d = expandVars(cmd.words[m + 1].v, cmd.env); dir = d === null ? null : path.resolve(dir, d); m++; }
  }
  const initArgs = cmd.words.slice(j + 1).filter((w, m, all) => !/^(-b|--initial-branch|--template|--separate-git-dir|--object-format|--ref-format)$/.test((all[m - 1] || {}).v || ''));
  const target = sub === 'init' && nonFlags(initArgs)[0];
  if (target && dir) { const d = expandVars(target.v, cmd.env); dir = d === null ? null : path.resolve(dir, d); }
  return { what: `git ${sub}`, dir };
}

const realp = (p) => {
  let cur = p;
  const tail = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  try { return path.join(fs.realpathSync.native(cur), ...tail); } catch { return p; }
};
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');

const ROLE_TEXT = {
  reviewer: 'ревьюер не пишет файлов и не меняет git (роль hub:reviewer): находку и предлагаемую правку — в отчёт, временное — в /tmp',
  explorer: 'разведчик только читает (роль hub:explorer): выводы — в отчёт, временное — в /tmp',
  tester: 'тестировщик пишет только тесты (роль hub:tester): правка рабочего кода — находка в отчёт',
};

function agentRoles(ev, ctx = {}) {
  const role = roleOf(ev.agent_type);
  const targets = callTargets(ev).map((t) => ({ ...t, real: realp(t.path) }));
  const mem = targets.find((t) => /(^|\/)\.claude\/agent-memory(\/|$)/.test(t.real));
  if (mem) return { decision: 'deny', reason: `Хаб (agent-roles): ${mem.path} — агенты не пишут память в рабочий репозиторий (.claude/agent-memory): урок — строкой «Предлагаю в errors.md» в отчёте.` };
  if (!ROLE_TEXT[role]) return null;

  const hub = ctx.hub ? realp(ctx.hub) : null;
  const hubMem = hub && targets.find((t) => t.real.startsWith(`${hub}/projects/`) && t.real.slice(hub.length + 10).split('/')[1] === 'memory');
  if (hubMem) return { decision: 'deny', reason: `Хаб (agent-roles): ${hubMem.path} — агенты не пишут память проекта: урок — строкой «Предлагаю в errors.md» в отчёте, запишет основная сессия.` };

  const why = ROLE_TEXT[role];
  const cwd = ev.cwd || process.cwd();
  const command = ev.tool_name === 'Bash' && (ev.tool_input || {}).command;
  const gits = typeof command === 'string' ? parseShell(command, cwd).map(gitWrite).filter((g) => g && g.dir) : [];
  if (!targets.length && !gits.length) return null;
  // The working repository is the session's one (its git top, else cwd); the scratchpad, /tmp and a scratch repo
  // there are the agent's own — notes and probes are fine.
  const root = realp(gitOut(cwd, ['rev-parse', '--show-toplevel']) || cwd);
  const bad = targets.find((t) => inside(t.real, root) && !(role === 'tester' && TEST_PATH.test(t.real)));
  if (bad) return { decision: 'deny', reason: `Хаб (agent-roles): ${why}; запись в ${bad.path} (${bad.via})${role === 'tester' ? ' — не тест' : ''}.` };
  const g = gits.find((x) => inside(realp(x.dir), root));
  if (g) return { decision: 'deny', reason: `Хаб (agent-roles): ${why}; ${g.what} меняет рабочий репозиторий ${root}.` };
  return null;
}

module.exports = { SCRIPTS_DIR, parseShell, writeTargets, classify, gitWrite, protectFiles, inlineScript, agentModel, agentRoles };
