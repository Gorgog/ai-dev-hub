// Hub rules in Bash commands for step0.py: stdin - a JSON array of commands, stdout - a JSON array, same order, of
// {rules: {<rule>: 0|1}, events: [...]}. A key in `rules` is an opportunity of that rule, its value -
// violated. Read by words outside quotes, comments and heredoc bodies, simple command by simple command (the tokenizer
// of shell-flags.cjs); `cd` - the polygon's own parser: an opportunity is any `cd` command (in a subshell too), a
// violation - a bare one (polygon/lib/shell.cjs).
//   git-add-all     git add            -> the path ., or -A/--all with no path named
//   sed-in-place    sed -i             -> always (Edit calls are its kept opportunities, counted by step0.py)
//   no-verify       git commit         -> --no-verify or a short cluster with n
//   clean-x         git clean          -> a short cluster with x or X
//   worktree-force  git worktree remove-> --force or a short cluster with f
//   checkout-dot    git checkout/restore -> the path . (restore --staged alone touches no file: no opportunity)
// events - in the command's order: 'commit' (a git commit) and 'checks' (the checks script, checks.cjs / checks.sh,
// run with --full after it).
'use strict';
const path = require('path');
const { bareCd } = require(path.join(__dirname, '..', '..', '..', 'polygon', 'lib', 'shell.cjs'));

// Simple commands as word lists: split by ; & | ( ) { } and newlines outside quotes; heredoc bodies and comments skipped,
// a heredoc inside "$( … )" too (not a here-string <<<, not a shift in $(( … ))); & of a redirection (2>&1, &>f) is no
// separator.
const HEREDOC = /^<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/;
const heredocAt = (s, i) => (s[i] === '<' && s[i - 1] !== '<' ? s.slice(i).match(HEREDOC) : null);

function simpleCommands(cmd) {
  const s = String(cmd);
  const out = [];
  let words = [], w = '', inWord = false, quote = null, heredoc = null, subst = 0;
  const pending = [];
  const endWord = () => { if (inWord) words.push(w); w = ''; inWord = false; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (heredoc) {
      let end = s.indexOf('\n', i);
      if (end === -1) end = s.length;
      if (s.slice(i, end).replace(/^\t+/, '') === heredoc) heredoc = pending.shift() || null;
      i = end;
      continue;
    }
    if ((quote === '"' || !quote) && s.startsWith('$((', i) && s.indexOf('))', i) !== -1) {  // arithmetic: one word
      const end = s.indexOf('))', i) + 1;
      w += s.slice(i, end + 1); inWord = true; i = end;
      continue;
    }
    if (quote === '"' && c === '$' && s[i + 1] === '(') { subst++; w += '$('; i++; continue; }
    if (quote === '"' && subst) {
      if (c === ')') subst--;
      const qhd = heredocAt(s, i);
      if (qhd) { pending.push(qhd[2]); w += qhd[0]; i += qhd[0].length - 1; continue; }
      if (c === '\n' && pending.length) { w += c; heredoc = pending.shift(); continue; }
    }
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < s.length) { w += s[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      w += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; subst = 0; inWord = true; continue; }
    if (c === '$' && s[i + 1] === '{') {
      const end = s.indexOf('}', i);
      if (end !== -1) { w += s.slice(i, end + 1); inWord = true; i = end; continue; }
    }
    if (c === '\\') { if (s[i + 1] !== '\n') { w += s[i + 1] || ''; inWord = true; } i++; continue; }
    const hd = heredocAt(s, i);
    if (hd) { endWord(); pending.push(hd[2]); i += hd[0].length - 1; continue; }
    if (c === '#' && !inWord) { const end = s.indexOf('\n', i); i = (end === -1 ? s.length : end) - 1; continue; }
    if (c === '\n') { endCmd(); if (pending.length) heredoc = pending.shift(); continue; }
    if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>')) { w += c; inWord = true; continue; }
    if (';&|(){}'.includes(c)) { endCmd(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    w += c;
    inWord = true;
  }
  endCmd();
  return out;
}

const PREFIX = new Set(['command', 'time', 'exec', 'sudo', 'nohup', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const cluster = (w, letters) => /^-[A-Za-z]+$/.test(w) && [...letters].some((l) => w.includes(l));

// Wrappers that run the command after their options: options that take an argument.
const WRAPPERS = {
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs']),
};

// Redirections out of the words: an operator alone takes the next word (its target) with it.
function withoutRedirections(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (/^(\d+|&)?(>>?|<)$/.test(words[i])) i++;
    else if (!/^(\d+|&)?(>>?|<)/.test(words[i])) out.push(words[i]);
  }
  return out;
}

// The program and its arguments: redirections, shell prefixes, NAME=value assignments and wrappers (timeout DURATION,
// env, xargs) skipped.
function program(raw) {
  const words = withoutRedirections(raw);
  let i = 0;
  for (;;) {
    while (i < words.length && (PREFIX.has(words[i]) || /^\w+=/.test(words[i]))) i++;
    const opts = WRAPPERS[path.basename(words[i] || '')];
    if (!opts) return words.slice(i);
    const wrapper = path.basename(words[i++]);
    while (i < words.length && words[i].startsWith('-')) i += opts.has(words[i]) ? 2 : 1;
    if (wrapper === 'timeout') i++;
  }
}

// find … -exec CMD … ; / + : the commands find runs.
function execCommands(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== '-exec' && words[i] !== '-execdir') continue;
    let j = i + 1;
    while (j < words.length && words[j] !== ';' && words[j] !== '+') j++;
    out.push(words.slice(i + 1, j));
    i = j;
  }
  return out;
}

// git's subcommand and its arguments, global options skipped; null - not git.
function gitArgs(words) {
  if (!/^git(\.exe)?$/.test(path.basename(words[0] || ''))) return null;
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += GIT_ARG_OPTS.has(words[i]) ? 2 : 1;
  return words.slice(i);
}

function rulesOf(cmd) {
  const rules = {};
  const set = (rule, v) => { rules[rule] = Math.max(rules[rule] || 0, v ? 1 : 0); };
  const events = [];
  const visit = (raw) => {
    const words = program(raw);
    if (!words.length) return;
    const name = path.basename(words[0]);
    const args = words.slice(1);
    if (name === 'cd') set('cd', 0);
    if (name === 'sed' && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))) set('sed-in-place', 1);
    const ci = words.findIndex((w) => /^checks\.(cjs|sh)$/.test(path.basename(w)));
    if (ci !== -1 && words.slice(ci + 1).includes('--full')) events.push('checks');
    if (name === 'find') execCommands(words).forEach(visit);
    const g = gitArgs(words);
    if (!g || !g.length) return;
    const [sub, ...rest] = g;
    if (sub === 'add') {
      const dd = rest.indexOf('--');
      const paths = dd === -1 ? rest.filter((a) => !a.startsWith('-')) : rest.slice(dd + 1);
      const all = rest.slice(0, dd === -1 ? rest.length : dd).some((a) => a === '--all' || cluster(a, 'A'));
      set('git-add-all', paths.includes('.') || (all && !paths.length));
    }
    if (sub === 'commit') {
      events.push('commit');
      set('no-verify', rest.some((a) => a === '--no-verify' || cluster(a, 'n')));
    }
    if (sub === 'clean') set('clean-x', rest.some((a) => cluster(a, 'xX')));
    if (sub === 'worktree' && rest[0] === 'remove') set('worktree-force', rest.some((a) => a === '--force' || cluster(a, 'f')));
    const staged = rest.some((a) => a === '--staged' || a === '-S') && !rest.some((a) => a === '--worktree' || a === '-W');
    if (sub === 'checkout' || (sub === 'restore' && !staged)) set('checkout-dot', rest.includes('.'));
  };
  simpleCommands(cmd).forEach(visit);
  if ('cd' in rules) rules.cd = bareCd(cmd) ? 1 : 0;
  else if (bareCd(cmd)) rules.cd = 1;
  return { rules, events };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify(JSON.parse(input || '[]').map(rulesOf)), () => process.exit(0));
});
