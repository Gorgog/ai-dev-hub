// node --test hub-run.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'hub-run.sh');
const run = (args, env = {}) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
const hasSystemd = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0;
const scoped = { skip: !hasSystemd && 'no systemd user manager' };
// A unique marker per test run: processes are found by it in /proc, units by the name.
const tag = `t${process.pid}`;
// A process whose argv[0] is the marker (exec -a): the command lines of hub-run and bash -c merely mention it.
const alive = (marker) => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).some((pid) => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] === marker; } catch { return false; }
});
const waitFor = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((ok) => setTimeout(ok, 100))) if (fn()) return true;
  return fn();
};

test('hub-run: the exit code of the command passes through', scoped, () => {
  const r = run([`${tag}-code`, '--', 'bash', '-c', 'echo out; exit 7']);
  assert.strictEqual(r.status, 7, r.stderr);
  assert.strictEqual(r.stdout, 'out\n');
  assert.match(r.stderr, /код 7 · пик/);
});

test('hub-run: MemoryMax kills only the run, a neighbour lives on', scoped, async (t) => {
  const marker = `${tag}-neighbour`;
  const neighbour = spawn('bash', ['-c', `exec -a ${marker} sleep 60`], { stdio: 'ignore' });
  t.after(() => neighbour.kill('SIGKILL'));
  assert.ok(await waitFor(() => alive(marker)));
  const hog = 'const a = []; for (;;) a.push(Buffer.alloc(1e7, 1));';
  const r = run([`${tag}-hog`, '-MemoryMax', '150M', '--', process.execPath, '-e', hog]);
  assert.strictEqual(r.status, 137, r.stderr);
  assert.match(r.stderr, /убит: MemoryMax 150M/);
  assert.ok(alive(marker), 'the neighbour outside the scope survived');
});

test('hub-run: --stop stops the whole tree of a run, children included', scoped, async (t) => {
  const marker = `${tag}-tree`;
  const job = spawn('bash', [SCRIPT, `${tag}-tree-dev`, '--', 'bash', '-c',
    `(exec -a ${marker}-child sleep 120) & exec -a ${marker}-main sleep 120`], { stdio: 'ignore' });
  let code = null;
  job.on('exit', (c, s) => { code = c === null ? s : c; });
  t.after(() => { if (code === null) { run(['--stop', `${tag}-tree`]); job.kill('SIGKILL'); } });
  assert.ok(await waitFor(() => alive(`${marker}-child`) && alive(`${marker}-main`)), 'the run started');
  assert.match(run(['--list']).stdout, new RegExp(`hub-${tag}-tree-dev-\\d+\\.scope +active`));
  const s = run(['--stop', `${tag}-tree`]);
  assert.strictEqual(s.status, 0, s.stderr);
  assert.match(s.stdout, new RegExp(`остановлен hub-${tag}-tree-dev-`));
  assert.ok(await waitFor(() => !alive(`${marker}-child`) && !alive(`${marker}-main`)), 'every process of the run is gone');
  assert.ok(await waitFor(() => code !== null), 'hub-run returned');
  assert.notStrictEqual(code, 0);
  assert.strictEqual(run(['--stop', `${tag}-tree`]).status, 1, 'nothing left to stop');
});

test('hub-run: timeout stops the run with code 124', scoped, () => {
  const t0 = Date.now();
  const r = run([`${tag}-slow`, '-Timeout', '1', '--', 'sleep', '30']);
  assert.strictEqual(r.status, 124, r.stderr);
  assert.match(r.stderr, /таймаут 1 с/);
  assert.ok(Date.now() - t0 < 10000);
});

test('hub-run fallback without systemd: warns, passes the code, kills the process group on timeout', async () => {
  const env = { HUB_RUN_NO_SYSTEMD: '1' };
  const ok = run([`${tag}-fb`, '--', 'bash', '-c', 'exit 5'], env);
  assert.strictEqual(ok.status, 5);
  assert.match(ok.stderr, /без лимита памяти/);
  const marker = `${tag}-fbchild`;
  const r = run([`${tag}-fb`, '-Timeout', '1', '--', 'bash', '-c', `(exec -a ${marker} sleep 60) & sleep 60`], env);
  assert.strictEqual(r.status, 124, r.stderr);
  assert.ok(await waitFor(() => !alive(marker), 3000), 'the background child of the run is killed too');
});

test('hub-run: bad arguments are a usage error', () => {
  assert.strictEqual(run([]).status, 2);
  assert.strictEqual(run(['x', '-MemoryMax', 'lots', '--', 'true']).status, 2);
  assert.strictEqual(run(['x', '--']).status, 2);
});
