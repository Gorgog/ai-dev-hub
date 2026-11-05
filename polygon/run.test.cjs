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

// Замороженная база acceptance §1 — 24/45 на сценариях до снятия cd-no-subshell (~/hub-data/polygon/v1-ef519e3.json).
// cd-bare в H03 сняты 05.11 (CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR держит cwd, правило снято): у v1 правило ещё было,
// на этих двух случаях он теперь «шумит» — на текущих сценариях прототип v1 — 22/45.
test('run --ref ef519e3: прототип H01–H04 — 22/45 на текущих сценариях (база 24/45 — до снятия cd-bare)', () => {
  const d = tmp();
  const r = run(['--level', 'hook', '--ref', 'ef519e3', '--only', '^H0[1-4]$', '--quiet', '--work', d, '--out', path.join(d, 'r.json')],
    { HUB_DATA: path.join(d, 'none') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /прототип H01–H04: 22\/45/);
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

test('run: незнакомый флаг, лишнее слово или флаг без значения — usage и код 2, без прогона', () => {
  const d = tmp();
  // --hub — пустая папка: раннер, принявший флаг за «прогон всего», падает на materialize раньше любого сценария,
  // модельные (тяжёлое) не стартуют даже на старом коде.
  const empty = tmp();
  for (const args of [['--help'], ['-h'], ['--level', 'hook', '--bogus'], ['H02'], ['--level', 'modle'],
    ['compare', 'a.json'], ['--level', 'hook', '--repeats', 'x'], ['--level', 'hook', '--only']]) {
    const r = run(['--hub', empty, '--work', d, ...args], { HUB_DATA: path.join(d, 'none') });
    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: node polygon\/run\.cjs/, args.join(' '));
    assert.doesNotMatch(r.stderr, /сценариев \d+/, `${args.join(' ')}: прогон не начался`);
  }
  assert.deepStrictEqual(fs.readdirSync(d), [], 'папка работы пуста — прогона не было');
});
