// node --test polygon/run.test.cjs — раннер полигона как команда: хук-уровень без модели, лёгкое.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUN = path.join(__dirname, 'run.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'polygon-run-'));
const run = (args, env = {}) => spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', timeout: 120000,
  env: { ...process.env, ...env } });
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('run: красные проверки не меняют код выхода без --strict; без ~/hub-data — строка о пропуске', () => {
  const d = tmp();
  const out = path.join(d, 'r.json');
  const r = run(['--level', 'hook', '--only', '^H03$', '--quiet', '--work', d, '--out', out], { HUB_DATA: path.join(d, 'none') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /реальные корпуса пропущены/);
  assert.match(r.stdout, /ворота: \d+\/\d+ · ловит \d+\/\d+ · не шумит \d+\/\d+/);
  const res = load(out).results[0];
  assert.strictEqual(res.mech, 'rules-guard');
  assert.ok(res.runs[0].checks.every((c) => c.kind === 'catch' || c.kind === 'quiet'));
  const strict = run(['--level', 'hook', '--only', '^H03$', '--quiet', '--strict', '--work', d, '--out', out], { HUB_DATA: path.join(d, 'none') });
  assert.strictEqual(strict.status, 1, 'на ef519e3-подобном H03 есть красные проверки ворот');
});

test('run: реальный корпус из HUB_DATA добавляет проверки real:', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'polygon', 'corpus'), { recursive: true });
  fs.writeFileSync(path.join(d, 'polygon', 'corpus', 'H03.json'),
    JSON.stringify([{ id: 'cd-bare-real', command: 'cd /x && ls', expect: true, source: 'журнал' }]));
  const out = path.join(d, 'r.json');
  const r = run(['--level', 'hook', '--only', '^H03$', '--quiet', '--work', d, '--out', out], { HUB_DATA: d });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /реальные корпуса: H03 \(1\)/);
  const real = load(out).results[0].runs[0].checks.find((c) => c.id === 'real:cd-bare-real');
  assert.ok(real && real.real === true);
});

test('run --ref ef519e3: прототип H01–H04 — 24/45, как базовая линия', () => {
  const d = tmp();
  const r = run(['--level', 'hook', '--ref', 'ef519e3', '--only', '^H0[1-4]$', '--quiet', '--work', d, '--out', path.join(d, 'r.json')],
    { HUB_DATA: path.join(d, 'none') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /прототип H01–H04: 24\/45/);
});

test('run: сценарии H05–H13 и I01 есть и запускаются без падения раннера; контракты помечены', () => {
  const d = tmp();
  const out = path.join(d, 'r.json');
  const r = run(['--level', 'hook', '--only', '^(H0[5-9]|H1[0-3]|I01)$', '--quiet', '--work', d, '--out', out],
    { HUB_DATA: path.join(d, 'none') });
  assert.strictEqual(r.status, 0, r.stderr);
  const R = load(out).results;
  assert.deepStrictEqual(R.map((s) => s.id), ['H05', 'H06', 'H07', 'H08', 'H09', 'H10', 'H11', 'H12', 'H13', 'I01']);
  for (const s of R) assert.ok(!s.runs[0].checks.some((c) => c.id === 'crash'), `${s.id}: ${JSON.stringify(s.runs[0].checks[0])}`);
  assert.deepStrictEqual(R.filter((s) => s.contract).map((s) => s.id), ['H06', 'H09', 'H10', 'H12', 'H13', 'I01']);
  const pass = (id, c) => R.find((s) => s.id === id).runs[0].checks.find((x) => x.id === c);
  assert.strictEqual(pass('H05', 'two-rounds-sum').pass, true, 'session-time на этой ревизии видит оба отрезка');
  assert.strictEqual(pass('H07', 'text-conflict').pass, true);
});

test('compare: строки «ловит» и «не шумит», регрессия — код 1', () => {
  const d = tmp();
  const res = (pass) => ({ hub: { ref: 'x', sha: 's' }, results: [{ id: 'H02', level: 'hook', title: 'H02', mech: 'lock',
    runs: [{ checks: [{ id: 'fp', pass, kind: 'quiet' }, { id: 'tp', pass: true, kind: 'catch' }] }] }] });
  fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify(res(true)));
  fs.writeFileSync(path.join(d, 'b.json'), JSON.stringify(res(false)));
  const r = run(['compare', path.join(d, 'a.json'), path.join(d, 'b.json')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /lock\s+ловит 1\/1 → 1\/1\s+не шумит 1\/1 → 0\/1/);
  assert.match(r.stdout, /хуже: 1/);
});
