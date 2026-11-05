// Shell flags of Bash commands for calls.py: stdin - a JSON array of commands, stdout - a JSON array of
// {bare_cd: 0|1, push: 0|1, grant: 0|1}, same order. bare_cd - the polygon's own shell parser (polygon/lib/shell.cjs), not the
// hub's regexps; push - a simple command that is `git … push` (git's global options skipped), read by words outside
// quotes and heredoc bodies: `git stash push`, `git add push.md`, `echo "git push"` are not pushes; grant - a simple
// command that runs the lock's grant.cjs (node, node.exe or a $variable holding it, then the script; variables set
// earlier in the command are expanded: G=…/grant.cjs; node $G …), not reads it.
'use strict';
const path = require('path');
const { bareCd } = require(path.join(__dirname, '..', '..', 'polygon', 'lib', 'shell.cjs'));

// Simple commands as word lists: split by ; & | ( ) { } and newlines outside quotes; heredoc bodies and comments skipped.
function simpleCommands(cmd) {
  const s = String(cmd);
  const out = [];
  let words = [], w = '', inWord = false, quote = null, heredoc = null;
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
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < s.length) { w += s[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      w += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === '$' && s[i + 1] === '{') {  // ${NAME…} is one word, its braces are no command separators
      const end = s.indexOf('}', i);
      if (end !== -1) { w += s.slice(i, end + 1); inWord = true; i = end; continue; }
    }
    if (c === '\\') { if (s[i + 1] !== '\n') { w += s[i + 1] || ''; inWord = true; } i++; continue; }
    const hd = c === '<' ? s.slice(i).match(/^<<-?\s*(['"]?)([A-Za-z_]\w*)\1/) : null;
    if (hd) { endWord(); pending.push(hd[2]); i += hd[0].length - 1; continue; }
    if (c === '#' && !inWord) { const end = s.indexOf('\n', i); i = (end === -1 ? s.length : end) - 1; continue; }
    if (c === '\n') { endCmd(); if (pending.length) heredoc = pending.shift(); continue; }
    if (';&|(){}'.includes(c)) { endCmd(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    w += c;
    inWord = true;
  }
  endCmd();
  return out;
}

const PREFIX = new Set(['command', 'time', 'exec', 'sudo', 'nohup', '!', 'then', 'do', 'else']);
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function gitPush(cmd) {
  for (const words of simpleCommands(cmd)) {
    let i = 0;
    while (i < words.length && (PREFIX.has(words[i]) || /^\w+=/.test(words[i]))) i++;
    if (!/^git(\.exe)?$/.test(path.basename(words[i] || ''))) continue;
    i++;
    while (i < words.length && words[i].startsWith('-')) i += GIT_ARG_OPTS.has(words[i]) ? 2 : 1;
    if (words[i] === 'push') return true;
  }
  return false;
}

// $NAME / ${NAME} words replaced by what a plain NAME=value earlier in the command set (split into words).
function expand(words, vars) {
  return words.flatMap((w) => {
    const m = w.match(/^\$\{?(\w+)\}?$/);
    return m && vars.has(m[1]) ? vars.get(m[1]).split(/\s+/).filter(Boolean) : [w];
  });
}

function grantRun(cmd) {
  const vars = new Map();
  for (const raw of simpleCommands(cmd)) {
    const assigns = raw.filter((w) => /^\w+=/.test(w));
    if (assigns.length === raw.length) {
      for (const a of assigns) vars.set(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
      continue;
    }
    const words = expand(raw, vars);
    let i = 0;
    while (i < words.length && (PREFIX.has(words[i]) || /^\w+=/.test(words[i]))) i++;
    const prog = words[i] || '';
    if (/(^|[\\/])grant\.cjs$/.test(prog)) return true;
    if (!/^(node(\.exe)?|\$\{?\w+\}?)$/.test(path.basename(prog))) continue;
    i++;
    let check = false;  // node --check only parses the file
    for (; i < words.length && words[i].startsWith('-'); i++) if (['--check', '-c'].includes(words[i])) check = true;
    if (!check && /(^|[\\/])grant\.cjs$/.test(words[i] || '')) return true;
  }
  return false;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const cmds = JSON.parse(input || '[]');
  process.stdout.write(JSON.stringify(cmds.map((c) => ({ bare_cd: bareCd(c) ? 1 : 0, push: gitPush(c) ? 1 : 0, grant: grantRun(c) ? 1 : 0 }))));
});
