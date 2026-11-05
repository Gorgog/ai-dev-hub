// Hub rules in Bash commands for step0.py: stdin - a JSON array of commands, stdout - a JSON array, same order, of
// {rules: {<rule>: 0|1}, events: [...]}. A key in `rules` is an opportunity of that rule, its value -
// violated. Read run by run: the programs the command runs, by the lock's shell reader without the disk
// (../shell-read.cjs: quotes, comments and heredoc bodies are data; wrappers - env, timeout, xargs, find -exec, … - run
// what follows them); `cd` - the polygon's own parser: an opportunity is any `cd` command (in a subshell too), a
// violation - a bare one (polygon/lib/shell.cjs).
//   git-add-all     git add            -> the path ., or -A/--all with no path named
//   sed-in-place    sed -i             -> always (Edit calls are its kept opportunities, counted by step0.py)
//   no-verify       git commit         -> --no-verify or a short cluster with n
//   clean-x         git clean          -> a short cluster with x or X
//   worktree-force  git worktree remove-> --force or a short cluster with f
//   checkout-dot    git checkout/restore -> the path . (restore --staged alone touches no file: no opportunity)
// events - in the command's order: 'commit' (a git commit) and 'checks' (the checks script, checks.cjs / checks.sh,
// run with --full after it); a wrapper and the program it starts are one run, one event.
'use strict';
const path = require('path');
const { bareCd } = require(path.join(__dirname, '..', '..', '..', 'polygon', 'lib', 'shell.cjs'));
const { execs, sameRun } = require(path.join(__dirname, '..', 'shell-read.cjs'));

const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const cluster = (w, letters) => /^-[A-Za-z]+$/.test(w) && [...letters].some((l) => w.includes(l));

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
  const runs = execs(cmd);
  runs.forEach(({ argv: words }, k) => {
    if (!words.length) return;
    const child = k > 0 && sameRun(runs[k - 1].argv, words);
    const name = path.basename(words[0]);
    const args = words.slice(1);
    if (name === 'cd') set('cd', 0);
    if (name === 'sed' && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))) set('sed-in-place', 1);
    const ci = words.findIndex((w) => /^checks\.(cjs|sh)$/.test(path.basename(w)));
    if (ci !== -1 && words.slice(ci + 1).includes('--full') && !child) events.push('checks');
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
  });
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
