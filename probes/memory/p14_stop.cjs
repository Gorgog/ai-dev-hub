#!/usr/bin/env node
// P14: a stand-in for the Stop hook that commits project memory to its local git under `flock -n`: the lock is
// busy (another session commits) → skip at once, no waiting. Nothing changed → no commit.
//   node p14_stop.cjs <memory-dir>    stdin: Stop hook JSON   stdout: {"_probe": {result, ms}}
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const t0 = process.hrtime.bigint();
const mem = process.argv[2];
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const lock = path.join(mem, '.git', 'hub-memory.lock');
const msg = `memory: stop ${input.session_id || '?'}`;
// One shell under the lock: add, commit only if the index differs. Exit 75 = the lock was busy.
const script = 'git add -A -- lessons events && { git diff --cached --quiet && echo nothing || git commit -q -m "$1"; }';
const r = spawnSync('flock', ['-n', '-E', '75', lock, 'sh', '-c', script, 'sh', msg], { cwd: mem, encoding: 'utf8' });
const result = r.status === 75 ? 'busy' : r.status !== 0 ? 'error' : /nothing/.test(r.stdout) ? 'nothing' : 'committed';
process.stdout.write(JSON.stringify({ _probe: { result, ms: Number(process.hrtime.bigint() - t0) / 1e6,
  stderr: (r.stderr || '').slice(-300) } }) + '\n');
