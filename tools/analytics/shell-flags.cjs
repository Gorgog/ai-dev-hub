// Shell flags of Bash commands for calls.py: stdin - a JSON array of commands, stdout - a JSON array of
// {bare_cd: 0|1, push: 0|1, grant: 0|1}, same order. bare_cd - the polygon's own shell parser (polygon/lib/shell.cjs), not the
// hub's regexps; push - a program run that is `git … push` (git's global options skipped): `git stash push`,
// `git add push.md`, `echo "git push"` are not pushes; grant - a run of the lock's grant.cjs (directly, or node /
// node.exe with it as the script; variables set earlier in the command are expanded: G=…/grant.cjs; node $G …), not a
// read of it. Programs - by the lock's shell reader without the disk (shell-read.cjs): quotes, heredoc bodies (inside
// "$( … )" too) and comments are data.
'use strict';
const path = require('path');
const { bareCd } = require(path.join(__dirname, '..', '..', 'polygon', 'lib', 'shell.cjs'));
const { execs } = require(path.join(__dirname, 'shell-read.cjs'));

const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const GRANT = /(^|[\\/])grant\.cjs$/;

// git's subcommand: global options skipped.
function gitSub(argv) {
  if (!/^git(\.exe)?$/.test(path.basename(argv[0] || ''))) return null;
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) i += GIT_ARG_OPTS.has(argv[i]) ? 2 : 1;
  return argv[i] || null;
}

const gitPush = (runs) => runs.some((e) => gitSub(e.argv) === 'push');

// grant.cjs run directly, or node with it as the script (node --check / -c only parses the file).
function grantRun(runs) {
  return runs.some(({ argv }) => {
    if (GRANT.test(argv[0] || '')) return true;
    if (!/^node(\.exe)?$/.test(path.basename(argv[0] || ''))) return false;
    let i = 1, check = false;
    for (; i < argv.length && argv[i].startsWith('-'); i++) if (['--check', '-c'].includes(argv[i])) check = true;
    return !check && GRANT.test(argv[i] || '');
  });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const cmds = JSON.parse(input || '[]');
  process.stdout.write(JSON.stringify(cmds.map((c) => {
    const runs = execs(c);
    return { bare_cd: bareCd(c) ? 1 : 0, push: gitPush(runs) ? 1 : 0, grant: grantRun(runs) ? 1 : 0 };
  })), () => process.exit(0));
});
