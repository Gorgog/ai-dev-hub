#!/usr/bin/env node
// The dispatcher's side of the resource lock: writes <project>/memory/dispatch-grants.json, which guard.cjs reads.
// usage:
//   node grant.cjs <project-dir> show
//   node grant.cjs <project-dir> grant <heavy|medium> <worktree> <minutes> "<what>"
//   node grant.cjs <project-dir> release <heavy|medium> [<worktree>]
// <worktree> = the worktree folder name (projects/<p>/worktrees/<worktree>), i.e. the branch from wt-new.sh.
// One holder per kind. "grant" refuses while another worktree holds an unexpired grant (release it first).
// The file is replaced atomically (temp file + rename) so the hook never reads half a file.
'use strict';
const fs = require('fs');
const path = require('path');

const [, , projectDir, cmd, kind, holder, minutes, ...whatParts] = process.argv;
function die(msg) { process.stderr.write(msg + '\n'); process.exit(1); }
if (!projectDir || !cmd) die('usage: grant.cjs <project-dir> show | grant <heavy|medium> <worktree> <minutes> "<what>" | release <heavy|medium> [<worktree>]');

const file = path.join(projectDir, 'memory', 'dispatch-grants.json');
let grants = {};
try { grants = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { grants = {}; }

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(grants, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function show() {
  const now = Date.now();
  for (const k of ['heavy', 'medium']) {
    const g = grants[k];
    if (!g || !g.holder) { console.log(`${k}: free`); continue; }
    const expired = g.until && Date.parse(g.until) <= now ? ' (EXPIRED)' : '';
    console.log(`${k}: ${g.holder} — ${g.what || ''} с ${new Date(g.since).toLocaleString('ru-RU')} до ${new Date(g.until).toLocaleString('ru-RU')}${expired}`);
  }
}

if (cmd === 'show') { show(); process.exit(0); }
if (!['heavy', 'medium'].includes(kind)) die('kind must be heavy or medium');

if (cmd === 'grant') {
  if (!holder || !minutes || !/^\d+$/.test(minutes)) die('grant needs <worktree> <minutes>');
  const cur = grants[kind];
  if (cur && cur.holder && cur.holder !== holder && (!cur.until || Date.parse(cur.until) > Date.now())) {
    die(`refused: ${kind} is held by ${cur.holder} until ${new Date(cur.until).toLocaleString('ru-RU')}; release it first`);
  }
  const now = new Date();
  grants[kind] = {
    holder,
    what: whatParts.join(' '),
    since: now.toISOString(),
    until: new Date(now.getTime() + Number(minutes) * 60000).toISOString(),
  };
  save(); show();
} else if (cmd === 'release') {
  const cur = grants[kind];
  if (holder && cur && cur.holder && cur.holder !== holder) die(`refused: ${kind} is held by ${cur.holder}, not ${holder}`);
  delete grants[kind];
  save(); show();
} else {
  die(`unknown command ${cmd}`);
}
