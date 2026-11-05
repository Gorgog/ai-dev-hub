// node --test corrections.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseJournal, corrections, apply, MIN_ROWS } = require('./corrections.cjs');

const SCRIPT = path.join(__dirname, 'corrections.cjs');
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// The header of templates/project/memory/estimates.md.
const HEAD = '| Дата | Ключ | Слож. | МР | Признаки | Прогноз | Прогноз +20% | Аналоги | Факт (акт / ожид) | Факт +20% | Попал | Причина, почему |\n' +
  '|---|---|---|---|---|---|---|---|---|---|---|---|\n';
const row = ({ key, c = 3, f, a, hit = 'нет' }) => `| 2026-10-01 | ${key} | ${c} | 1 | Б | ${f} | — | — | ${a} | — | ${hit} | — |`;
const journal = (rows) => `# Журнал оценок\n\n## Поправки\n_Пока нет._\n\n## Строки\n${HEAD}${rows.map(row).join('\n')}\n`;
// Ten closed rows, fact ÷ middle of the forecast: 0.5 ×5, 0.375, 0.333, 0.6, 0.7, 0.8 — median 0.5.
const TEN = [[120, 60], [90, 45], [60, 30], [240, 120], [100, 50], [80, 30], [60, 20], [120, 72], [200, 140], [50, 40]]
  .map(([f, a], i) => ({ key: `DEMO-${i + 1}`, c: i < 5 ? 2 : 5, f: `${f} мин`, a: `${a} / 5 мин` }));

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });

test('ten closed rows: the factor is the median of fact ÷ middle of the forecast', () => {
  const r = corrections(parseJournal(journal(TEN)));
  assert.strictEqual(r.n, 10);
  assert.strictEqual(r.factor, 0.5);
});

test('fewer than ten closed rows: no factor, the analogues lead', () => {
  assert.strictEqual(MIN_ROWS, 10);
  const r = corrections(parseJournal(journal(TEN.slice(0, 9))));
  assert.strictEqual(r.n, 9);
  assert.strictEqual(r.factor, null);
  assert.deepStrictEqual(r.classes, {});
});

test('open, retro and cancelled rows are not closed; real formats of the column are read', () => {
  const rows = [
    ...TEN,
    { key: 'OPEN-1', f: '30–60 мин', a: '' },
    { key: 'RETRO-1', c: '2 (ретро)', f: '2–4 ч (на глаз)', a: '27 / 14 мин, 1 раунд', hit: '×0,15' },
    { key: 'GONE-1', f: '20–40 мин', a: '9 / 2 мин сессии, отменена', hit: '—' },
  ];
  const parsed = parseJournal(journal(rows));
  assert.strictEqual(parsed.length, 13);
  assert.strictEqual(parsed.filter((x) => x.closed).length, 10);
  const one = (f, a) => parseJournal(journal([{ key: 'X-1', f, a }]))[0];
  assert.deepStrictEqual(one('1,5–3 ч', '45 / 4 мин, 1 раунд').forecast, { min: 90, max: 180 });
  assert.strictEqual(one('1,5–3 ч', '45 / 4 мин, 1 раунд').active, 45);
  assert.strictEqual(one('30–50 мин', '≈25 мин (`dir` 123 минус 98)').active, 25);
  assert.strictEqual(one('60–100 мин', '56 мин / 15 мин ожидания, 2 раунда').active, 56);
  assert.deepStrictEqual(one('2–4 ч (поле); 4–8 ч (сетка)', '60 / 0 мин').forecast, { min: 120, max: 240 });
  assert.deepStrictEqual(one('45-90 мин', '60 / 0 мин').forecast, { min: 45, max: 90 });
});

test('classes by complexity 1–3 / 4–6 / 7–10, a class factor only from 3 rows', () => {
  const rows = [...TEN, { key: 'BIG-1', c: 8, f: '100 мин', a: '100 / 0 мин' }];
  const r = corrections(parseJournal(journal(rows)));
  assert.deepStrictEqual(r.classes['1–3'], { n: 5, factor: 0.5 });
  assert.strictEqual(r.classes['4–6'].n, 5);
  assert.strictEqual(r.classes['4–6'].factor, 0.6);
  assert.deepStrictEqual(r.classes['7–10'], { n: 1, factor: null });
});

test('apply: the forecast range times the class factor, else the overall one; nothing without a factor', () => {
  const r = corrections(parseJournal(journal(TEN)));
  assert.deepStrictEqual(apply(r, { min: 30, max: 60 }, 2), { min: 15, max: 30, factor: 0.5, by: '1–3' });
  assert.deepStrictEqual(apply(r, { min: 30, max: 60 }, 9), { min: 15, max: 30, factor: 0.5, by: 'все' });
  assert.deepStrictEqual(apply(r, { min: 30, max: 60 }), { min: 15, max: 30, factor: 0.5, by: 'все' });
  const none = corrections(parseJournal(journal(TEN.slice(0, 3))));
  assert.deepStrictEqual(apply(none, { min: 30, max: 60 }, 2), { min: 30, max: 60, factor: null, by: null });
});

test('CLI: «×0.5» as text, {factor} as JSON, no «×<number>» under ten rows, --apply prints the corrected range', () => {
  const d = tmp();
  const full = path.join(d, 'full.md'), few = path.join(d, 'few.md');
  fs.writeFileSync(full, journal(TEN));
  fs.writeFileSync(few, journal(TEN.slice(0, 6)));
  const t = run(full);
  assert.strictEqual(t.status, 0, t.stderr);
  assert.match(t.stdout, /поправка ×0\.5 \(N = 10/);
  const j = JSON.parse(run(full, '--json').stdout);
  assert.strictEqual(j.factor, 0.5);
  assert.strictEqual(j.n, 10);
  const f = run(few);
  assert.strictEqual(f.status, 0, f.stderr);
  assert.match(f.stdout, /поправки нет: закрытых строк 6 < 10/);
  assert.doesNotMatch(f.stdout, /[×x]\s*\d/);
  assert.strictEqual(JSON.parse(run(few, '--json').stdout).factor, null);
  const a = run(full, '--apply', '40–80', '--complexity', '2');
  assert.strictEqual(a.status, 0, a.stderr);
  assert.match(a.stdout, /прогноз 40–80 мин × 0\.5 \(класс 1–3\) = 20–40 мин/);
  assert.strictEqual(run(path.join(d, 'nope.md')).status, 1);
  assert.strictEqual(run(full, '--apply', 'много').status, 1);
});
