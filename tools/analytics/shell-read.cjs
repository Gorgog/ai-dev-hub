// Shell reading of the analytics (06, 11, 24): the lock's reader (plugin/skills/dispatch/scripts/shell.cjs, slice 15)
// over a command from a journal. execs(cmd) → [{argv: [string]}], every program the command runs, in its order: simple
// commands of lists, pipes, subshells and $( ); what wrappers run in turn (env, timeout, xargs, find -exec, bash -c,
// node <script>, …). Quotes, heredoc bodies (inside "$( … )" too) and comments are data.
// Without the disk: the command ran on another day in another tree, the script it named then is not the file there
// now, so a script is never opened (`bash x.sh`, `./x.sh`, `source x` — the call alone) and the reading is the same on
// any machine. The reader has no option for it: its fs calls fail for the time of the call.
'use strict';
const fs = require('fs');
const path = require('path');
const { executions } = require(path.join(__dirname, '..', '..', 'plugin', 'skills', 'dispatch', 'scripts', 'shell.cjs'));

const NO_DISK = ['statSync', 'lstatSync', 'openSync', 'readSync', 'readFileSync', 'existsSync', 'accessSync', 'realpathSync'];
const nope = () => { const e = new Error('analytics: no disk'); e.code = 'ENOENT'; throw e; };

// The index of the )) that closes $(( at i, or -1: the parentheses balance on one line and close with two at once.
function arithEnd(s, i) {
  let depth = 2;
  for (let j = i + 3; j < s.length && s[j] !== '\n'; j++) {
    if (s[j] === '(') depth++;
    else if (s[j] === ')' && --depth === 1) return s[j + 1] === ')' ? j + 1 : -1;
  }
  return -1;
}

// `$((cd x && git add .) | wc)` is a subshell inside a substitution, not arithmetic (bash falls back to it), and the
// reader takes every $(( for arithmetic: such a $(( is given its space. Inside single quotes it only changes data.
const subshells = (s) => s.replace(/\$\(\(/g, (m, i) => (arithEnd(s, i) === -1 ? '$( (' : m));

function execs(cmd) {
  const saved = NO_DISK.map((k) => fs[k]);
  NO_DISK.forEach((k) => { fs[k] = k === 'existsSync' ? () => false : nope; });
  try {
    return executions(subshells(String(cmd)), { cwd: '/', env: { HOME: '/' } }).execs.map((e) => ({ argv: e.argv }));
  } finally {
    NO_DISK.forEach((k, i) => { fs[k] = saved[i]; });
  }
}

// A wrapper and the program it starts are one run: the child's argv is the tail of its parent's (`timeout 60 node
// x.cjs` → `node x.cjs` → `x.cjs`). For counting runs (events), not for «does any run match».
const sameRun = (parent, child) => child.length > 0 && child.length < parent.length
  && child.every((w, k) => w === parent[parent.length - child.length + k]);

module.exports = { execs, sameRun };
