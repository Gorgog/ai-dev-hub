// node --test headroom.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'headroom.sh');
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
// Memory thresholds at 0: only the checked condition can fail, whatever the machine has free right now.
const run = (args, env = {}) => spawnSync('bash', [SCRIPT, '-MinGB', '0', '-MinPhysGB', '0', ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } });
const psi = (dir, some60, full10) => {
  const f = path.join(dir, 'psi');
  fs.writeFileSync(f, `some avg10=1.00 avg60=${some60} avg300=0.00 total=1\nfull avg10=${full10} avg60=0.00 avg300=0.00 total=1\n`);
  return f;
};

test('headroom: PSI line always, exit 5 on memory pressure (full avg10 or some avg60)', (t) => {
  const d = tmp(t);
  const calm = run([], { HEADROOM_PSI_FILE: psi(d, '3.00', '0.50') });
  assert.strictEqual(calm.status, 0, calm.stdout);
  assert.match(calm.stdout, /^PSI memory: some avg10 1% avg60 3%, full avg10 0\.5%/m);
  assert.strictEqual(run([], { HEADROOM_PSI_FILE: psi(d, '3.00', '2.00') }).status, 5);
  const some = run([], { HEADROOM_PSI_FILE: psi(d, '12.50', '0.00') });
  assert.strictEqual(some.status, 5);
  assert.match(some.stdout, /DO NOT GRANT: memory pressure/);
  assert.strictEqual(run(['-MaxPsiSome', '20'], { HEADROOM_PSI_FILE: psi(d, '12.50', '0.00') }).status, 0);
  assert.strictEqual(run(['-MinGB', '100000'], { HEADROOM_PSI_FILE: psi(d, '12.50', '0.00') }).status, 2, 'headroom wins over pressure');
});

test('headroom -Worktrees: Pss summed per worktree by the cwd of processes', async (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'K-1', 'apps'), { recursive: true });
  fs.mkdirSync(path.join(root, 'K-2'));
  const kids = [path.join(root, 'K-1', 'apps'), path.join(root, 'K-1'), path.join(root, 'K-2')]
    .map((cwd) => spawn('sleep', ['30'], { cwd, stdio: 'ignore' }));
  t.after(() => kids.forEach((k) => k.kill('SIGKILL')));
  await new Promise((ok) => setTimeout(ok, 200));
  const r = run(['-Worktrees', root], { HEADROOM_PSI_FILE: '/nonexistent' });
  assert.match(r.stdout, /^PSI memory: \/nonexistent not readable/m);
  assert.match(r.stdout, /^ {2}K-1 +\d+\.\d\d GB {2}2 processes$/m);
  assert.match(r.stdout, /^ {2}K-2 +\d+\.\d\d GB {2}1 processes$/m);
  assert.match(r.stdout, /^HUB-RUN units:/m);
  const empty = tmp(t);
  assert.match(run(['-Worktrees', empty]).stdout, /no processes inside/);
});
