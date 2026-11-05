// Shell reading for the dispatcher's lock (slice 15): which programs a Bash command really runs, not which words
// its text contains. executions(cmd, { cwd }) → { execs, unknown, error }:
//   execs   — every program run, as { argv: [string], env: {NAME: value}, bin: bool }: each simple command of
//             lists, pipes, subshells, $( ), ` `, <( ); and what wrappers start in turn — env, timeout, nice, sudo,
//             xargs, find -exec, watch, flock, dotenv/cross-env/env-cmd, hub-run.sh, bash/sh -c, eval, npx and the
//             other package runners (bin: true — a node package binary, as `npx jest`), node <node_modules/…/bin>,
//             shell scripts (read from disk, $@ bound to the call's arguments), source / . (its variables apply).
//             Variables assigned in the command are expanded, unquoted ones split into words; text in quotes,
//             heredoc bodies, comments, case patterns, `for … in` lists and [[ ]] are data, not programs.
//   unknown — reasons the program cannot be known before the run (a variable from outside, eval "$X",
//             `… | bash`): the caller judges such a command by its text, as before.
//   error   — the command does not parse (unclosed quote or bracket); execs so far are partial.
// Control flow is not followed: every branch counts as run (over-approximation is the safe side for a lock).
// Shared: the polygon re-exports it (polygon/lib/shell.cjs), so the lock and its graders read shell one way.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMITS = { depth: 3, execs: 400, hops: 12, scriptBytes: 256 * 1024, parses: 300, commands: 20000 };
// Programs whose arguments are data: a rule word among them is a mention (grep "npx jest", git commit -m "kubb
// generate"). The forms of these that do run an argument (git bisect run, trap, sed e, …) — runsArgs() below; code
// in awk/perl is not read, like node -e. Any other program the reader does not unwrap is `opaque`: it may run its
// arguments (xvfb-run, tmux, su -c, concurrently), the lock judges its line as text.
const INERT = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'mawk', 'perl', 'cat', 'tac', 'head',
  'tail', 'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'ls', 'stat', 'file', 'echo', 'printf', 'git', 'diff', 'cmp',
  'comm', 'jq', 'yq', 'base64', 'sha256sum', 'sha1sum', 'md5sum', 'touch', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'chmod',
  'chown', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'sleep', 'true', 'false', 'test', '[', ':', 'cd', 'pushd',
  'popd', 'export', 'declare', 'typeset', 'local', 'readonly', 'set', 'unset', 'read', 'shift', 'return', 'exit', 'wait',
  'kill', 'pkill', 'pgrep', 'ps', 'curl', 'wget', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'xxd', 'od', 'hexdump', 'strings',
  'iconv', 'column', 'paste', 'join', 'split', 'nl', 'fold', 'fmt', 'expand', 'seq', 'yes', 'printenv', 'which', 'type',
  'whereis', 'hash', 'alias', 'unalias', 'history', 'sqlite3', 'gh', 'du', 'df', 'free', 'uptime', 'id', 'whoami', 'hostname',
  'uname', 'nproc', 'lsof', 'netstat', 'ss', 'systemctl', 'journalctl', 'tree', 'mktemp', 'install', 'patch', 'shuf',
  'truncate', 'sync', 'clear', 'tput', 'stty', 'umask', 'ulimit', 'trap', 'getopts', 'let', 'mapfile', 'readarray', 'source', '.',
  'shopt', 'prettier', 'eslint']);
// Wrappers and runners the reader unwraps itself (their own line is not judged as text).
const UNWRAPS = new Set(['env', 'sudo', 'doas', 'nice', 'ionice', 'nohup', 'setsid', 'unbuffer', 'chronic', 'builtin', 'stdbuf',
  'caffeinate', 'time', 'exec', 'command', 'timeout', 'taskset', 'strace', 'ltrace', 'systemd-run', 'flock', 'xargs', 'watch',
  'find', 'dotenv', 'dotenv-cli', 'cross-env', 'cross-env-shell', 'env-cmd', 'hub-run.sh', 'docker', 'docker-compose', 'podman',
  'eval', 'npx', 'pnpx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun', 'node', 'python', 'python3', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!', 'time', 'coproc']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
// Wrapper scripts the lock knows by name: what they run is after `--`, their own body is not read.
const OPAQUE = new Set(['hub-run.sh']);
const META = /[ \t\n\r\f\v;&|()<>]/;
const BLANK = /[ \t\r\f\v]/;

class ShellError extends Error {}
// A limit of the whole reading is reached: stop at once (the command is «unknown», judged by its text).
class Abort extends Error {}

// The forms of «data» programs that run an argument as a command.
const SED_E = /(^|[;\n{}])\s*((\d+|\$|\/(?:[^/\\]|\\.)*\/)(\s*,\s*(\d+|\$|\/(?:[^/\\]|\\.)*\/))?)?\s*!?\s*e(\s|;|$)/;
// s///e — the s command at a command start (after ; { } or a newline, an optional address), not «s» inside text.
const SED_SE = /(^|[;\n{}])\s*((\d+|\$|\/(?:[^/\\]|\\.)*\/)(\s*,\s*(\d+|\$|\/(?:[^/\\]|\\.)*\/))?)?\s*!?\s*s([^\s\\\n])(?:(?!\6)[^\\]|\\.)*\6(?:(?!\6)[^\\]|\\.)*\6[gpiImMw0-9]*e/;
function runsArgs(name, argv) {
  const a = argv.slice(1);
  switch (name) {
    case 'git': return (a.includes('bisect') && a.includes('run')) || (a.includes('submodule') && a.includes('foreach'))
      || (a.includes('rebase') && a.some((x) => x === '-x' || x === '--exec' || x.startsWith('--exec=')))
      || a.some((x, k) => a[k - 1] === '-c' && /^alias\.[^=]*=!/.test(x));
    case 'trap': return a.length >= 2 && a[0] !== '-' && a[0] !== '';
    case 'sed': return a.some((x) => !x.startsWith('-') && (SED_E.test(x) || SED_SE.test(x)));
    case 'sqlite3': return a.some((x) => /(^|\n)\s*\.(shell|system)\b/.test(x));
    case 'tar': return a.some((x) => x === '-I' || /^--(to-command|use-compress-program|checkpoint-action|info-script|new-volume-script|rsh-command)/.test(x));
    case 'rg': return a.some((x) => x === '--pre' || x.startsWith('--pre='));
    default: return false;
  }
}

const field = () => ({ text: '', dyn: false, quoted: false });
const lit = (text) => ({ text, dyn: false, quoted: false });

function newScope(opts) {
  const vars = new Map();
  const home = (opts.env && opts.env.HOME) || os.homedir();
  vars.set('HOME', { text: home, dyn: false, exported: false });
  return { vars, cwd: opts.cwd || process.cwd(), pos: [], script: null };
}
const childScope = (s, over = {}) => ({ vars: new Map(s.vars), cwd: s.cwd, pos: s.pos, script: s.script, ...over });
// What a child process inherits: exported variables only.
const exportedScope = (s, over = {}) => {
  const vars = new Map();
  for (const [k, v] of s.vars) if (v.exported || k === 'HOME') vars.set(k, v);
  return { vars, cwd: s.cwd, pos: [], script: null, ...over };
};
const envOf = (s) => { const e = {}; for (const [k, v] of s.vars) if (v.exported) e[k] = v.text; return e; };

class Parser {
  constructor(src, scope, ctx, depth, opts = {}) {
    this.s = src; this.i = 0; this.scope = scope; this.ctx = ctx; this.depth = depth; this.bin = Boolean(opts.bin);
    this.heredocs = []; // pending: { delim, strip, cmd }
    this.queue = [];    // simple commands waiting for their heredoc bodies: { cmd, snap }
    this.caseDepth = 0; this.expectPattern = false;
    // Function definitions: the body's commands are kept, not run; a call runs them (Ctx.fns).
    this.fnName = null; this.braces = 0; this.frames = [];
  }

  run() {
    this.list(null, this.scope);
    this.drain();
  }

  // Parses commands until `stop` (')' of a subshell or $( ), or the end). Scope effects apply in order.
  list(stop, scope) {
    const s = this.s;
    let cur = { words: [], assigns: [], heredocs: [] };
    const flush = () => {
      if (cur.words.length || cur.assigns.length) this.finish(cur, scope);
      cur = { words: [], assigns: [], heredocs: [] };
    };
    while (true) {
      while (this.i < s.length && (BLANK.test(s[this.i]) || (s[this.i] === '\\' && s[this.i + 1] === '\n')))
        this.i += s[this.i] === '\\' ? 2 : 1;
      if (this.i >= s.length) {
        if (stop) throw new ShellError(`не закрыта «(»`);
        flush();
        return;
      }
      if (this.expectPattern && this.casePattern()) continue;
      const c = s[this.i];
      const atStart = !cur.words.length; // assignments may come one after another: A=1 B=2 cmd
      if (c === '#') { const e = s.indexOf('\n', this.i); this.i = e < 0 ? s.length : e; continue; }
      if (c === '\n') { flush(); this.i++; this.readHeredocs(); this.drain(); continue; }
      if (c === ')' && stop === ')') { flush(); this.i++; return; }
      if (c === ')') { this.i++; continue; }
      if (c === ';' || c === '&' || c === '|') {
        const op = this.at(/(;;&|;;|;&|&&|\|\||\|&|&>>|&>|[;&|])/y)[0];
        if (op.startsWith('&>')) { this.i += op.length; this.skipBlank(); this.words(scope); continue; }
        flush();
        if ((op === ';;' || op === ';&' || op === ';;&') && this.caseDepth) this.expectPattern = true;
        this.i += op.length;
        continue;
      }
      if ((c === '<' || c === '>') && s[this.i + 1] === '(') { // process substitution: its commands run
        this.i += 2;
        this.list(')', childScope(scope));
        cur.words.push({ text: '/dev/fd/63', dyn: true, quoted: false });
        continue;
      }
      if (c === '(') {
        if (atStart && s[this.i + 1] === '(') { this.skipArith(scope); continue; }
        const def = cur.words.length === 1 && this.at(/\(\s*\)/y);
        if (def) { // name() — a function definition
          this.i += def[0].length;
          this.fnName = cur.words[0].text;
          cur.words = [];
          continue;
        }
        this.fnName = null; // f() ( … ) — a subshell body runs as written
        flush();
        this.i++;
        this.list(')', childScope(scope));
        continue;
      }
      const redir = this.at(/\d*(<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/y);
      if (redir) { this.redirect(redir, cur, scope); continue; }
      if (atStart) {
        const asg = this.at(/([A-Za-z_][A-Za-z0-9_]*)\+?=/y);
        if (asg) {
          this.i += asg[0].length;
          let value;
          if (s[this.i] === '(') { this.skipBalanced('(', ')', scope); value = { text: '', dyn: true }; }
          else if (this.i >= s.length || META.test(s[this.i])) value = lit('');
          else value = join(this.readWord(scope, false));
          cur.assigns.push({ name: asg[1], value });
          continue;
        }
      }
      const start = this.i;
      const fields = this.readWord(scope, true);
      if (this.i === start) { this.i++; continue; } // a character no rule above took: never stall
      const raw = s.slice(start, this.i);
      if (!cur.words.length && /^[^'"\\$`]+$/.test(raw) && this.keyword(raw, scope)) continue;
      cur.words.push(...fields);
    }
  }

  // Words up to a separator, read and dropped (redirection targets, for-lists).
  words(scope) { if (this.i < this.s.length && !META.test(this.s[this.i])) this.readWord(scope, false); }
  skipBlank() { while (this.i < this.s.length && BLANK.test(this.s[this.i])) this.i++; }
  // A sticky regexp at the current position: no copy of the rest of the source per token (scripts run to 256 KB).
  at(re) { re.lastIndex = this.i; return re.exec(this.s); }

  keyword(w, scope) {
    const s = this.s;
    if (w === '{') {
      this.braces++;
      if (this.fnName) { this.frames.push({ name: this.fnName, level: this.braces, cmds: [] }); this.fnName = null; }
      return true;
    }
    if (w === '}') {
      const top = this.frames[this.frames.length - 1];
      if (top && top.level === this.braces) { this.frames.pop(); this.ctx.fns.set(top.name, top.cmds); }
      this.braces = Math.max(0, this.braces - 1);
      return true;
    }
    if (KEYWORDS.has(w)) {
      if (w === 'time') { this.skipBlank(); const m = this.at(/-p(?=\s)/y); if (m) this.i += m[0].length; }
      return true;
    }
    if (w === 'case') {
      this.skipBlank(); this.words(scope); this.skipBlank();
      const m = this.at(/in(?=[\s;]|$)/y);
      if (m) this.i += m[0].length;
      this.caseDepth++; this.expectPattern = true;
      return true;
    }
    if (w === 'esac') { this.caseDepth = Math.max(0, this.caseDepth - 1); this.expectPattern = false; return true; }
    if (w === 'for' || w === 'select') {
      this.skipBlank();
      if (s.startsWith('((', this.i)) { this.skipArith(scope); return true; }
      const name = this.at(/[A-Za-z_][A-Za-z0-9_]*/y);
      if (name) { this.i += name[0].length; scope.vars.set(name[0], { text: '', dyn: true, exported: false }); }
      this.skipBlank();
      if (this.at(/in(?=[\s;]|$)/y)) {
        this.i += 2;
        while (true) {
          this.skipBlank();
          if (this.i >= s.length || /[;\n&|)]/.test(s[this.i])) break;
          this.words(scope);
        }
      }
      return true;
    }
    if (w === '[[') {
      // Test expression: operands are data. Ends at a standalone ]].
      while (this.i < s.length) {
        this.skipBlank();
        if (this.at(/\]\](?=[\s;&|)]|$)/y)) { this.i += 2; return true; }
        if (s[this.i] === '\n') { this.i++; continue; }
        if (/[;&|()<>]/.test(s[this.i])) { this.i++; continue; }
        this.readWord(scope, false);
      }
      return true;
    }
    if (w === 'function') {
      this.skipBlank();
      const name = this.at(/[^\s;&|()<>{}]+/y);
      if (name) { this.i += name[0].length; this.fnName = name[0]; }
      this.skipBlank();
      const m = this.at(/\(\s*\)/y);
      if (m) this.i += m[0].length;
      return true;
    }
    return false;
  }

  // In a case: the pattern before ")" (or esac). True when it consumed something.
  casePattern() {
    const s = this.s;
    while (this.i < s.length && /[\s]/.test(s[this.i])) this.i++;
    if (this.i >= s.length) return false;
    const esac = this.at(/esac(?=[\s;&|)]|$)/y);
    if (esac) { this.i += 4; this.caseDepth = Math.max(0, this.caseDepth - 1); this.expectPattern = false; return true; }
    if (s[this.i] === '(') this.i++; // (a) — the optional opening parenthesis of a pattern
    let depth = 0;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') { this.i += 2; continue; }
      if (c === "'" || c === '"') { const e = s.indexOf(c, this.i + 1); if (e < 0) throw new ShellError('не закрыта кавычка'); this.i = e + 1; continue; }
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) { this.i++; break; } depth--; }
      this.i++;
    }
    this.expectPattern = false;
    return true;
  }

  // (( … )) or $(( … )): not commands, but $( ) and ` ` inside them run.
  skipArith(scope) {
    const start = this.i;
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) { this.ctx.expansions(this.s.slice(start, this.i), scope, this.depth); return; }
    }
    throw new ShellError('не закрыта «((»');
  }

  // An array value a=( … ): words, not commands; their substitutions run.
  skipBalanced(open, close, scope) {
    const start = this.i;
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '\\') { this.i += 2; continue; }
      if (c === "'" || c === '"') { const e = this.s.indexOf(c, this.i + 1); if (e < 0) throw new ShellError('не закрыта кавычка'); this.i = e + 1; continue; }
      this.i++;
      if (c === open) depth++;
      else if (c === close && --depth === 0) { this.ctx.expansions(this.s.slice(start, this.i), scope, this.depth); return; }
    }
    throw new ShellError(`не закрыта «${open}»`);
  }

  // Only the expansions of a text: $( ), ` `, ${ } — a heredoc body without quotes, an arithmetic, a default value.
  scan(scope) {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') { this.i += 2; continue; }
      if (c === '$') { this.expand(scope, true); continue; }
      if (c === '`') { this.backtick(scope); continue; }
      this.i++;
    }
    this.drain();
  }

  redirect(m, cur, scope) {
    const op = m[1];
    this.i += m[0].length;
    this.skipBlank();
    if (op === '<<' || op === '<<-') {
      const start = this.i;
      const fields = this.readWord(scope, false);
      const raw = this.s.slice(start, this.i);
      const delim = (fields[0] && fields[0].text) || raw.replace(/['"\\]/g, '');
      // Unquoted delimiter: the body is expanded — its $( ) and ` ` run.
      const pending = { delim, strip: op === '<<-', cmd: cur, expand: !/['"\\]/.test(raw), scope };
      this.heredocs.push(pending);
      return;
    }
    if (op === '<<<') { const w = join(this.readWord(scope, false)); cur.heredocs.push(w.text); return; }
    this.words(scope);
  }

  readHeredocs() {
    const s = this.s;
    while (this.heredocs.length) {
      const h = this.heredocs.shift();
      const lines = [];
      while (this.i < s.length) {
        const e = s.indexOf('\n', this.i);
        const line = s.slice(this.i, e < 0 ? s.length : e);
        this.i = e < 0 ? s.length : e + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        lines.push(line);
      }
      const body = lines.join('\n');
      if (h.expand && /[$`]/.test(body)) this.ctx.expansions(body, h.scope, this.depth);
      h.cmd.heredocs.push(body);
    }
  }

  // One shell word → its fields after expansion (unquoted expansions split on blanks; "$@" — one field per argument).
  readWord(scope, split) {
    const s = this.s;
    const start = this.i;
    const fields = [field()];
    let cur = fields[0];
    const add = (t, dyn) => { cur.text += t; if (dyn) cur.dyn = true; };
    const addValue = (v, quoted) => {
      if (v.list) { // "$@" / $@; no arguments — no word at all, quoted or not
        if (!v.list.length) cur.none = true;
        v.list.forEach((w, k) => { if (k) { cur = field(); fields.push(cur); } cur.text += w.text; cur.dyn = cur.dyn || w.dyn; if (quoted) cur.quoted = true; });
        return;
      }
      if (quoted || !split || v.dyn) { add(v.text, v.dyn); return; }
      const parts = v.text.split(/[ \t\n]+/);
      parts.forEach((p, k) => { if (k) { cur = field(); fields.push(cur); } cur.text += p; });
    };
    while (this.i < s.length) {
      const c = s[this.i];
      if (META.test(c)) break;
      if (c === "'") {
        const e = s.indexOf("'", this.i + 1);
        if (e < 0) throw new ShellError('не закрыта кавычка \'');
        add(s.slice(this.i + 1, e)); cur.quoted = true; this.i = e + 1; continue;
      }
      if (c === '"') { this.i++; this.readDouble(scope, (v) => addValue(v, true), add); cur.quoted = true; continue; }
      if (c === '\\') { add(s[this.i + 1] === '\n' ? '' : (s[this.i + 1] || '')); this.i += 2; continue; }
      if (c === '$') { addValue(this.expand(scope, false), false); continue; }
      if (c === '`') { this.backtick(scope); add('', true); continue; }
      if (c === '~' && this.i === start && (this.i + 1 >= s.length || /[/\s;&|)]/.test(s[this.i + 1]))) {
        const h = scope.vars.get('HOME'); add(h ? h.text : '~', !h); this.i++; continue;
      }
      add(c); this.i++;
    }
    return fields.filter((f) => f.text || f.dyn || (f.quoted && !f.none));
  }

  readDouble(scope, addValue, add) {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '"') { this.i++; return; }
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === '\n') { this.i += 2; continue; }
        add('$`"\\'.includes(n) ? n : c + (n || '')); this.i += 2; continue;
      }
      if (c === '$') { addValue(this.expand(scope, true)); continue; }
      if (c === '`') { this.backtick(scope); add('', true); continue; }
      add(c); this.i++;
    }
    throw new ShellError('не закрыта кавычка "');
  }

  backtick(scope) {
    const s = this.s;
    let j = this.i + 1, inner = '';
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\' && '`$\\'.includes(s[j + 1])) { inner += s[j + 1]; j += 2; continue; }
      inner += s[j++];
    }
    if (j >= s.length) throw new ShellError('не закрыта `');
    this.i = j + 1;
    this.ctx.sub(inner, childScope(scope), this.depth);
  }

  // At "$": → { text, dyn } or { list } for $@.
  expand(scope, quoted) {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === '(') {
      if (s[this.i + 2] === '(') { this.i++; this.skipArith(scope); return { text: '', dyn: true }; }
      this.i += 2;
      this.list(')', childScope(scope));
      return { text: '', dyn: true };
    }
    if (n === "'" && !quoted) { // $'…' — ANSI-C quoting
      let j = this.i + 2, t = '';
      const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', e: '\x1b', a: '\x07', b: '\b', v: '\v', f: '\f' };
      while (j < s.length && s[j] !== "'") { if (s[j] === '\\') { t += esc[s[j + 1]] !== undefined ? esc[s[j + 1]] : s[j + 1]; j += 2; } else t += s[j++]; }
      if (j >= s.length) throw new ShellError('не закрыта кавычка $\'');
      this.i = j + 1;
      return { text: t, dyn: false, literal: true };
    }
    if (n === '"' && !quoted) { this.i++; return { text: '', dyn: false }; } // $"…" — the quote is read next
    if (n === '{') {
      const e = this.matchBrace(this.i + 1);
      const inner = s.slice(this.i + 2, e);
      this.i = e + 1;
      const m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])([\s\S]*)$/);
      if (!m) return { text: '', dyn: true };
      const v = this.lookup(m[1], scope);
      const op = m[2];
      if (!op) return v;
      const alt = op.match(/^(:?)([-=+?])([\s\S]*)$/);
      if (alt) {
        const set = !v.dyn && !v.list && (alt[1] ? v.text !== '' : true) && scope.vars.has(m[1]);
        if (alt[2] === '+') return set ? { text: alt[3], dyn: false } : { text: '', dyn: !scope.vars.has(m[1]) && !/^\d+$/.test(m[1]) };
        if (set) return v;
        if (/[$`]/.test(alt[3])) this.ctx.expansions(alt[3], scope, this.depth); // ${X:-$(cmd)} runs cmd
        return { text: alt[3], dyn: true };
      }
      return { text: '', dyn: true };
    }
    this.i++;
    const name = this.at(/([A-Za-z_][A-Za-z0-9_]*|\d|[@*#?$!-])/y);
    this.i--;
    if (!name) { this.i++; return { text: '$', dyn: false }; }
    this.i += 1 + name[0].length;
    return this.lookup(name[0], scope);
  }

  matchBrace(open) {
    const s = this.s;
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return j;
    }
    throw new ShellError('не закрыта «${»');
  }

  lookup(name, scope) {
    if (name === '@' || name === '*') return scope.pos ? { list: scope.pos } : { text: '', dyn: true };
    if (/^\d+$/.test(name)) {
      if (name === '0') return scope.script ? { text: scope.script, dyn: false } : { text: 'bash', dyn: false };
      if (!scope.pos) return { text: '', dyn: true };
      const w = scope.pos[Number(name) - 1];
      return w ? { text: w.text, dyn: w.dyn } : { text: '', dyn: false };
    }
    if (name === '#') return scope.pos ? { text: String(scope.pos.length), dyn: false } : { text: '', dyn: true };
    const v = scope.vars.get(name);
    return v ? { text: v.text, dyn: v.dyn } : { text: '', dyn: true };
  }

  // A simple command is complete: its effects on the shell (variables, cd, source) apply now; the programs it runs
  // are read once its heredoc bodies are in (end of line).
  finish(cmd, scope) {
    this.ctx.work();
    const frame = this.frames[this.frames.length - 1];
    if (frame) { frame.cmds.push({ cmd, snap: childScope(scope) }); return; }
    if (!cmd.words.length) {
      for (const a of cmd.assigns) {
        const old = scope.vars.get(a.name);
        scope.vars.set(a.name, { text: a.value.text, dyn: a.value.dyn, exported: Boolean(old && old.exported) });
      }
      return;
    }
    const w0 = cmd.words[0];
    const args = cmd.words.slice(1);
    const name = w0.dyn ? null : w0.text;
    if (name === 'cd' || name === 'pushd') {
      const t = args.find((w) => !/^-[LPe@]$/.test(w.text));
      if (!t) { const h = scope.vars.get('HOME'); if (h) scope.cwd = h.text; }
      else if (!t.dyn && t.text !== '-') scope.cwd = path.resolve(scope.cwd, t.text);
    } else if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(name)) {
      const exp = name === 'export' || args.some((w) => /^-[a-zA-Z]*x/.test(w.text));
      for (const w of args) {
        const m = w.text.match(/^([A-Za-z_][A-Za-z0-9_]*)(\+?=)?([\s\S]*)$/);
        if (!m || w.text.startsWith('-')) continue;
        const old = scope.vars.get(m[1]);
        if (m[2]) scope.vars.set(m[1], { text: m[3], dyn: w.dyn, exported: exp || Boolean(old && old.exported) });
        else if (old && exp) old.exported = true;
      }
    } else if (name === 'unset') {
      for (const w of args) if (!w.text.startsWith('-')) scope.vars.delete(w.text);
    } else if (name === 'shift') {
      const k = args[0] && /^\d+$/.test(args[0].text) ? Number(args[0].text) : 1;
      if (scope.pos) scope.pos = scope.pos.slice(k);
    } else if (name === 'set') {
      const dd = args.findIndex((w) => w.text === '--');
      if (dd >= 0) scope.pos = args.slice(dd + 1);
    } else if (name === 'source' || name === '.') {
      if (args[0] && !args[0].dyn) this.ctx.script(path.resolve(scope.cwd, args[0].text), scope, args.length > 1 ? args.slice(1) : null, this.depth);
      else this.ctx.note(`${name}: файл известен только при запуске`);
    }
    this.queue.push({ cmd, snap: childScope(scope) });
  }

  drain() {
    while (this.queue.length) {
      const { cmd, snap } = this.queue.shift();
      const env = envOf(snap);
      for (const a of cmd.assigns) env[a.name] = a.value.text;
      this.ctx.exec(cmd.words, env, snap, { bin: this.bin, stdin: cmd.heredocs, depth: this.depth, hops: 0 });
    }
  }
}

const join = (fields) => ({ text: fields.map((f) => f.text).join(' '), dyn: fields.some((f) => f.dyn) });

// Options of a wrapper up to its first operand; `valued` take the next word. Returns the operand's index.
function skipOpts(argv, i, valued = []) {
  while (i < argv.length) {
    const a = argv[i].text;
    if (a === '--') return i + 1;
    if (!a.startsWith('-') || a === '-') return i;
    i += valued.includes(a) ? 2 : 1;
  }
  return i;
}
const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text);
const pkgBin = (spec) => {
  let p = spec.replace(/^(@?[^@]+)@.*$/, '$1'); // jest@29 → jest, @scope/x@1 → @scope/x
  if (p === '@playwright/test') return 'playwright';
  if (p.startsWith('@')) p = p.split('/')[1] || p;
  return p;
};
// node_modules/.bin/jest, node_modules/jest/bin/jest.js, node_modules/typescript/bin/tsc → the binary's name.
function binOfPath(p) {
  const norm = p.replace(/\\/g, '/');
  const k = norm.lastIndexOf('node_modules/');
  if (k < 0) return null;
  const rest = norm.slice(k + 'node_modules/'.length).split('/').filter(Boolean);
  if (rest[0] === '.bin') return rest[1] || null;
  const pkg = rest[0] && rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
  const after = rest.slice(pkg.split('/').length);
  const b = after.indexOf('bin');
  if (b >= 0 && after[b + 1]) return after[b + 1].replace(/\.(c|m)?js$/, '');
  return pkgBin(pkg);
}

// Whatever the reader could not see — a script not on disk, a limit reached — is «unknown», never «nothing runs»:
// the lock then judges the command by its text.
class Ctx {
  constructor(opts) {
    this.execs = []; this.unknown = []; this.opts = opts; this.parses = 0; this.commands = 0;
    this.fns = new Map(); this.calling = new Set(); this.files = new Map();
  }

  // One reason per kind, a short list: a self-sourcing script must not fill it with thousands of lines.
  note(why) { if (this.unknown.length < 20 && !this.unknown.includes(why)) this.unknown.push(why); }

  // Every simple command read counts; the whole reading is bounded.
  work() { if (++this.commands > LIMITS.commands) { this.note(`команд больше ${LIMITS.commands}`); throw new Abort(); } }

  // Room for one more parse: depth and the total number of parses are bounded (a script sourcing itself).
  room(depth) {
    if (depth + 1 > LIMITS.depth) { this.note(`вложенность больше ${LIMITS.depth}`); return false; }
    if (++this.parses > LIMITS.parses) { this.note(`разборов больше ${LIMITS.parses}`); throw new Abort(); }
    return true;
  }

  // A string run as shell code (bash -c, eval, npx -c, …).
  sub(src, scope, depth, opts = {}) {
    if (!this.room(depth)) return;
    try { new Parser(src, scope, this, depth + 1, opts).run(); }
    catch (e) { if (!(e instanceof ShellError)) throw e; this.note(`строка-код не разбирается: ${e.message}`); }
  }

  // Only the substitutions of a text ($( ), ` `) — they run; the text itself is data.
  expansions(text, scope, depth) {
    if (!this.room(depth)) return;
    try { new Parser(text, childScope(scope), this, depth + 1).scan(scope); }
    catch (e) { if (!(e instanceof ShellError)) throw e; this.note(`подстановка не разбирается: ${e.message}`); }
  }

  // A shell script from disk: `bash f`, `./f`, `source f` (sourced — in the caller's scope).
  script(file, scope, pos, depth, sourced = true) {
    if (OPAQUE.has(path.basename(file))) return;
    // Limits first: no stat, no read past them.
    if (depth + 1 > LIMITS.depth) return this.note(`вложенность больше ${LIMITS.depth}`);
    if (this.parses >= LIMITS.parses) { this.note(`разборов больше ${LIMITS.parses}`); throw new Abort(); }
    const text = this.read(file);
    if (text === null) return;
    const sc = sourced ? scope : exportedScope(scope, { pos: pos || [], script: file });
    if (sourced && pos) sc.pos = pos;
    this.sub(text, sc, depth);
  }

  // A script's text, once per file; null (and a note) when it cannot be read as one.
  read(file) {
    if (this.files.has(file)) return this.files.get(file);
    const miss = (why) => { this.note(`скрипт ${file} ${why}`); this.files.set(file, null); return null; };
    if (/^\/(proc|sys|dev)\//.test(file)) return miss('— не файл скрипта');
    let text;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return miss('— не обычный файл');
      if (st.size > LIMITS.scriptBytes) return miss(`больше ${LIMITS.scriptBytes} байт`);
      text = fs.readFileSync(file, 'utf8');
    } catch { return miss('не прочитан'); }
    if (text.includes('\0')) return miss('— не текст');
    this.files.set(file, text);
    return text;
  }

  // What an executable path is: 'missing' | 'shell' (sh shebang, or a text file without one — bash runs it as sh) |
  // 'node' | null (a binary, another interpreter, not a regular file).
  kind(file) {
    let st;
    try { st = fs.statSync(file); } catch { return 'missing'; }
    if (!st.isFile()) return null; // a FIFO or a device would block the open
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, 128, 0);
      fs.closeSync(fd);
      const bytes = buf.slice(0, n);
      if (bytes.includes(0)) return null;
      const head = bytes.toString('utf8').split('\n')[0];
      if (/^#!.*\bnode\b/.test(head)) return 'node';
      if (/^#!.*\b(ba|z|da|k|a)?sh\b/.test(head)) return 'shell';
      if (head.startsWith('#!')) return null;
      return 'shell';
    } catch { return null; }
  }

  exec(words, env, snap, o) {
    if (!words.length) return;
    if (this.execs.length >= LIMITS.execs) { this.note(`программ больше ${LIMITS.execs}`); throw new Abort(); }
    const w0 = words[0];
    if (w0.dyn) { this.note(`программа известна только при запуске: ${w0.text || '$…'}`); return; }
    const argv = words.map((w) => w.text);
    const name = path.basename(argv[0]);
    // A call of a function defined in this command or a sourced file: its body runs (once per call chain).
    const fn = !argv[0].includes('/') && this.fns.get(argv[0]);
    if (fn) {
      this.execs.push({ argv, dyn: words.map((w) => w.dyn), env: { ...env }, bin: false, opaque: false });
      if (this.calling.has(argv[0])) return;
      this.calling.add(argv[0]);
      try {
        for (const { cmd, snap: s2 } of fn) {
          const env2 = envOf(s2);
          for (const a of cmd.assigns) env2[a.name] = a.value.text;
          this.exec(cmd.words, env2, s2, { bin: false, stdin: cmd.heredocs, depth: o.depth, hops: o.hops + 1 });
        }
      } finally { this.calling.delete(argv[0]); }
      return;
    }
    // opaque — a program the reader neither unwraps nor knows as data-only: it may run its arguments.
    // dyn — per word, known only at run time (its text is what was known: '' for $(…), the literal part of a$X).
    const opaque = !o.data && ((!INERT.has(name) && !UNWRAPS.has(name)) || runsArgs(name, argv));
    const e = { argv, dyn: words.map((w) => w.dyn), env: { ...env }, bin: Boolean(o.bin), opaque };
    this.execs.push(e);
    if (o.hops >= LIMITS.hops) { this.note(`обёрток больше ${LIMITS.hops}`); return; }
    // What a wrapper starts: a package binary stays one (npx cross-env … jest — jest from node_modules/.bin).
    const next = (rest, more = {}, extra = {}) => this.exec(rest, { ...env, ...more }, snap, { ...o, read: true, data: false, hops: o.hops + 1, ...extra });
    const code = (src, extra = {}) => {
      if (src.dyn) this.note(`строка-код известна только при запуске: ${argv[0]}`);
      this.sub(src.text, extra.scope || childScope(snap), o.depth, { bin: extra.bin });
    };
    const assignsThen = (i) => {
      const more = {};
      while (i < words.length && isAssign(words[i])) { const [k, ...v] = words[i].text.split('='); more[k] = v.join('='); i++; }
      return [i, more];
    };
    const at = (i) => words.slice(i);

    switch (name) {
      case 'env': {
        let i = 1;
        while (i < words.length && words[i].text.startsWith('-') && words[i].text !== '--') {
          const a = words[i].text;
          if (a === '-S' || a === '--split-string') { code(join(at(i + 1))); return; }
          i += ['-u', '--unset', '-C', '--chdir'].includes(a) ? 2 : 1;
        }
        if (words[i] && words[i].text === '--') i++;
        const [j, more] = assignsThen(i);
        return next(at(j), more);
      }
      case 'sudo': case 'doas': {
        const [j, more] = assignsThen(skipOpts(words, 1, ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir']));
        return next(at(j), more);
      }
      case 'nice': return next(at(skipOpts(words, 1, ['-n', '--adjustment'])));
      case 'ionice': return next(at(skipOpts(words, 1, ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'])));
      case 'nohup': case 'setsid': case 'unbuffer': case 'chronic': case 'builtin': case 'stdbuf':
        return next(at(skipOpts(words, 1, ['-i', '-o', '-e'])));
      case 'caffeinate': return next(at(skipOpts(words, 1, ['-t', '-w'])));
      case 'time': return next(at(skipOpts(words, 1, ['-f', '-o', '--format', '--output'])));
      case 'exec': return next(at(skipOpts(words, 1, ['-a'])));
      case 'command': {
        if (words.slice(1).some((w) => w.text === '-v' || w.text === '-V')) return;
        return next(at(skipOpts(words, 1)));
      }
      case 'timeout': { const i = skipOpts(words, 1, ['-s', '--signal', '-k', '--kill-after']); return next(at(i + 1)); }
      case 'taskset': { const i = skipOpts(words, 1); return next(at(i + 1)); }
      case 'strace': case 'ltrace': return next(at(skipOpts(words, 1, ['-o', '-e', '-p', '-s', '-u', '-E'])));
      case 'systemd-run': return next(at(skipOpts(words, 1, ['-p', '-E', '-u', '-M', '-H', '--unit', '--property', '--setenv',
        '--slice', '--uid', '--gid', '--nice', '--working-directory', '--description', '--machine', '--host', '--service-type',
        '--on-active', '--on-boot', '--on-startup', '--on-unit-active', '--on-unit-inactive', '--on-calendar'])));
      case 'flock': {
        let i = 1;
        while (i < words.length && words[i].text.startsWith('-')) {
          const a = words[i].text;
          if (a === '-c' || a === '--command') return code(words[i + 1] || lit(''));
          i += ['-w', '--timeout', '-E', '--conflict-exit-code'].includes(a) ? 2 : 1;
        }
        i++; // the lock file
        if (words[i] && (words[i].text === '-c' || words[i].text === '--command')) return code(words[i + 1] || lit(''));
        return next(at(i));
      }
      case 'xargs': {
        const i = skipOpts(words, 1, ['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a', '--delimiter', '--max-args', '--max-procs',
          '--arg-file', '--replace', '--eof', '--max-lines', '--max-chars']);
        return next(at(i));
      }
      case 'watch': {
        const exe = words.some((w) => w.text === '-x' || w.text === '--exec');
        const i = skipOpts(words, 1, ['-n', '--interval', '-q', '--equexit']);
        return exe ? next(at(i)) : code(join(at(i)));
      }
      case 'find': {
        for (let i = 1; i < words.length; i++) {
          if (!['-exec', '-execdir', '-ok', '-okdir'].includes(words[i].text)) continue;
          let j = i + 1;
          while (j < words.length && words[j].text !== ';' && words[j].text !== '+') j++;
          next(words.slice(i + 1, j));
          i = j;
        }
        return;
      }
      case 'dotenv': case 'dotenv-cli': return next(at(skipOpts(words, 1, ['-e', '-v', '-c'])));
      case 'cross-env': case 'cross-env-shell': {
        const [j, more] = assignsThen(1);
        return name === 'cross-env-shell' ? code(join(at(j))) : next(at(j), more);
      }
      case 'env-cmd': return next(at(skipOpts(words, 1, ['-f', '--file', '-e', '--environments', '-r', '--rc-file'])));
      case 'hub-run.sh': {
        const dd = argv.indexOf('--');
        if (dd > 0) next(at(dd + 1));
        break; // and the script itself, if readable
      }
      case 'docker': case 'docker-compose': case 'podman': {
        // docker exec|run [opts] CONTAINER|IMAGE cmd…; docker compose [-f f] exec|run [opts] SERVICE cmd… — cmd runs.
        let i = 1;
        if (name === 'docker-compose' || (words[1] && words[1].text === 'compose')) {
          i = skipOpts(words, name === 'docker-compose' ? 1 : 2, ['-f', '--file', '-p', '--project-name', '--env-file', '--profile', '--project-directory', '--ansi', '--progress']);
        }
        const sub = words[i] && words[i].text;
        if (sub !== 'exec' && sub !== 'run') return;
        const more = {};
        let j = i + 1;
        const VALUED = ['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--detach-keys', '-v', '--volume', '-p', '--publish',
          '--name', '--network', '--net', '--entrypoint', '-m', '--memory', '--cpus', '--mount', '-l', '--label', '--add-host', '--platform',
          '--pull', '--restart', '-h', '--hostname', '--link', '--log-driver', '--tmpfs', '--device', '--cap-add', '--cap-drop',
          '--security-opt', '--ulimit', '--shm-size', '--gpus', '--ipc', '--pid', '--dns', '--index', '--memory-swap', '--user-ns'];
        while (j < words.length && words[j].text.startsWith('-')) {
          const a = words[j].text;
          if ((a === '-e' || a === '--env') && words[j + 1] && /^[A-Za-z_]\w*=/.test(words[j + 1].text)) {
            const [k, ...v] = words[j + 1].text.split('='); more[k] = v.join('=');
          }
          j += VALUED.includes(a) ? 2 : 1;
        }
        return next(at(j + 1), more); // past the container / image / service
      }
      case 'eval': return code(join(at(1)));
      case 'npx': case 'pnpx': case 'bunx': return this.runner(words, 1, next, code);
      case 'npm': case 'pnpm': case 'yarn': case 'bun': {
        const valued = ['--prefix', '-w', '--workspace', '--loglevel', '--userconfig', '--cache', '--registry', '--filter', '-F',
          '-C', '--dir', '--workspace-dir', '--reporter', '--cwd', '--config'];
        const i = skipOpts(words, 1, valued);
        const sub = words[i] && words[i].text;
        if ((name === 'npm' && (sub === 'exec' || sub === 'x')) || (name === 'pnpm' && (sub === 'exec' || sub === 'dlx'))
          || (name === 'yarn' && (sub === 'dlx' || sub === 'exec')) || (name === 'bun' && sub === 'x'))
          return this.runner(words, i + 1, next, code);
        if (name === 'yarn' && sub === 'workspace' && words[i + 2]) return next([words[0], ...at(i + 2)]);
        return;
      }
      case 'node': {
        let i = 1;
        while (i < words.length && words[i].text.startsWith('-')) {
          const a = words[i].text;
          if (['-e', '--eval', '-p', '--print', '-c', '--check', '-i', '--interactive', '-v', '--version', '-h', '--help'].includes(a)) return;
          if (a === '--') { i++; break; }
          i += ['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--inspect-port', '--title',
            '--input-type', '--conditions', '-C'].includes(a) ? 2 : 1;
        }
        const file = words[i];
        const bin = file && !file.dyn && binOfPath(file.text);
        if (bin) return next([lit(bin), ...at(i + 1)], {}, { bin: true });
        // The script is the program the rules name (polygon/run.cjs --model); its JS is not read.
        if (file && !file.dyn) return next(at(i), {}, { read: false, data: true });
        return;
      }
      case 'python': case 'python3': {
        let i = 1;
        while (i < words.length && words[i].text.startsWith('-')) {
          const a = words[i].text;
          if (a === '-c' || a === '-V' || a === '--version' || a === '-h' || a === '--help') return;
          if (a === '-m') return words[i + 1] && !words[i + 1].dyn ? next(at(i + 1), {}, { read: false, data: true }) : undefined;
          i += ['-W', '-X', '-Q'].includes(a) ? 2 : 1;
        }
        if (words[i] && !words[i].dyn) return next(at(i), {}, { read: false, data: true });
        return;
      }
    }

    if (SHELLS.has(name)) {
      let i = 1, cflag = false, noexec = false;
      while (i < words.length) {
        const a = words[i].text;
        if (a === '--') { i++; break; }
        if (!/^[-+]/.test(a) || a === '-' || a === '+') break;
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) cflag = true;
        if (/^-[a-zA-Z]*n[a-zA-Z]*$/.test(a) || (a === '-o' && words[i + 1] && words[i + 1].text === 'noexec')) noexec = true;
        i += ['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(a) ? 2 : 1;
      }
      if (noexec) return; // bash -n: syntax check, nothing runs
      if (cflag) {
        const src = words[i] || lit('');
        return code(src, { scope: exportedScope(snap, { pos: at(i + 2) }) });
      }
      if (words[i]) {
        const f = words[i];
        if (f.dyn) { this.note(`скрипт известен только при запуске: ${argv[0]} ${f.text || '$…'}`); return; }
        // The script is a program too (rules name scripts); its body is read here, whatever its shebang.
        next(at(i), {}, { read: false, data: true });
        return this.script(path.resolve(snap.cwd, f.text), snap, at(i + 1), o.depth, false);
      }
      if (o.stdin && o.stdin.length) { for (const t of o.stdin) this.sub(t, exportedScope(snap), o.depth); return; }
      this.note(`${name} читает команды со входа`);
      return;
    }

    // A path: a package binary, or a script read from disk.
    if (argv[0].includes('/') && o.read !== false) { // not the script of an interpreter (node f, bash f): that is data or read above
      const bin = binOfPath(argv[0]);
      if (bin) { e.opaque = false; return next([lit(bin), ...at(1)], {}, { bin: true }); }
      const file = path.resolve(snap.cwd, argv[0]);
      const kind = this.kind(file);
      if (kind === 'missing' && !OPAQUE.has(name)) this.note(`${argv[0]} нет на диске (пишется в этой же команде?)`);
      if (kind === 'node') e.opaque = false;
      if (kind === 'shell') { e.opaque = false; this.script(file, snap, at(1), o.depth, false); }
    }
  }

  // npx / pnpm exec / yarn dlx / bunx …: options, then the package binary and its arguments.
  runner(words, i, next, code) {
    while (i < words.length) {
      const a = words[i].text;
      if (a === '--') { i++; break; }
      if (a === '-c' || a === '--call' || a === '--shell-mode') return code(words[i + 1] || lit(''), { bin: true });
      if (['-p', '--package', '--prefix', '-w', '--workspace', '--cache', '--userconfig', '--registry', '--loglevel',
        '--node-options', '--filter', '-F', '-C', '--dir', '--cwd'].includes(a)) { i += 2; continue; }
      if (!a.startsWith('-')) break;
      i++;
    }
    const w = words[i];
    if (!w) return;
    if (w.dyn) { this.note(`пакет известен только при запуске: ${w.text || '$…'}`); return; }
    return next([lit(pkgBin(w.text)), ...words.slice(i + 1)], {}, { bin: true });
  }
}

function executions(cmd, opts = {}) {
  const ctx = new Ctx(opts);
  const scope = newScope(opts);
  try {
    new Parser(String(cmd), scope, ctx, 0).run();
  } catch (e) {
    if (e instanceof Abort) return { execs: ctx.execs, unknown: ctx.unknown, error: null };
    if (!(e instanceof ShellError)) throw e;
    return { execs: ctx.execs, unknown: ctx.unknown, error: e.message };
  }
  return { execs: ctx.execs, unknown: ctx.unknown, error: null };
}

module.exports = { executions };
