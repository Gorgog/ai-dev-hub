// Контракт механизма (срез 19): поправку оценок считает скрипт, а не модель «на глаз». 30 из 33 оценок были завышены,
// медиана факт/прогноз ×0,5. Заготовка интерфейса: `estimate/scripts/corrections.cjs <estimates.md>` печатает
// множитель (`×0.5` или JSON `{ "factor": 0.5 }`); при < 10 закрытых строк поправки нет. Срез 19 уточняет интерфейс
// вместе с этим сценарием.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HEAD = '| Дата | Ключ | Слож. | МР | Признаки | Прогноз | Прогноз +20% | Аналоги | Факт (акт / ожид) | Факт +20% | Попал | Причина, почему |\n' +
  '|---|---|---|---|---|---|---|---|---|---|---|---|\n';
// Прогноз и факт в минутах; отношения факт/прогноз: медиана ровно 0,5.
const PAIRS = [[120, 60], [90, 45], [60, 30], [240, 120], [100, 50], [80, 30], [60, 20], [120, 72], [200, 140], [50, 40]];
const row = ([f, a], i) => `| 2026-10-${String(i + 1).padStart(2, '0')} | DEMO-${i + 1} | 3 | 1 | Б | ${f} мин | ${Math.round(f * 1.2)} мин | — | ${a} / 5 мин | ${Math.round(a * 1.2)} мин | нет | — |`;
const journal = (pairs) => `# Журнал оценок\n\n## Строки\n${HEAD}${pairs.map(row).join('\n')}\n`;

function factor(script, file) {
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8', timeout: 30000 });
  const out = (r.stdout || '').trim();
  try { const j = JSON.parse(out); if (j && 'factor' in j) return { f: j.factor, out }; } catch { /* text */ }
  const m = out.match(/[×x]\s*(\d+(?:[.,]\d+)?)/);
  return { f: m ? Number(m[1].replace(',', '.')) : null, out: out || (r.stderr || '').slice(0, 160) };
}

module.exports = {
  id: 'H06', level: 'hook', mech: 'estimate', contract: true, title: 'Поправки оценки — скриптом (контракт 19)',
  async run({ base, work }) {
    const script = path.join(base, 'plugin', 'skills', 'estimate', 'scripts', 'corrections.cjs');
    if (!fs.existsSync(script)) {
      return ['factor-from-10-rows', 'no-factor-under-10'].map((id) => ({ id, kind: id.startsWith('no-') ? 'quiet' : 'catch',
        source: 'аудит №7 (30 из 33 завышены, медиана ×0,5)', pass: false, detail: 'нет estimate/scripts/corrections.cjs (срез 19)' }));
    }
    const full = path.join(work, 'estimates.md'), few = path.join(work, 'estimates-few.md');
    fs.writeFileSync(full, journal(PAIRS));
    fs.writeFileSync(few, journal(PAIRS.slice(0, 6)));
    const a = factor(script, full), b = factor(script, few);
    return [
      { id: 'factor-from-10-rows', source: 'аудит №7 (30 из 33 завышены, медиана ×0,5)',
        pass: a.f !== null && Math.abs(a.f - 0.5) <= 0.05, detail: `ждали ×0.5, вышло: ${a.out.slice(0, 120)}` },
      { id: 'no-factor-under-10', kind: 'quiet', source: 'шаблон estimates.md («меньше 10 — опора на аналоги»)',
        pass: b.f === null || b.f === 1, detail: `при 6 строках вышло: ${b.out.slice(0, 120)}` },
    ];
  },
};
