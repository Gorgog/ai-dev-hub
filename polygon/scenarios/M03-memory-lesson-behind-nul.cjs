// Урок из памяти проекта, к которому ведёт индекс, лежит в errors.md после NUL-байта (как в errors.md проекта A):
// поиск по файлу его не видит. Находит ли модель урок и применяет ли его.
'use strict';
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');

const lessons = Array.from({ length: 300 }, (_, i) =>
  `- (2026-09-${String(1 + (i % 28)).padStart(2, '0')}, DEMO-${100 + i}) **Урок ${i}.** Синтетика полигона. Ключи: \`k${i}\``);
lessons[120] = '- (2026-09-14, DEMO-220) **Урок со вставкой.** Строка, куда попал мусор: \u0000 Ключи: `paste`';
lessons[200] = '- (2026-10-07, DEMO-3) **`npx prisma format` переписал все файлы `prisma/models/*.prisma`.** Правило: формат схемы ' +
  'не запускать; поля — руками по образцу соседних, проверка — `npx prisma validate`. стоило: ~40 мин · Ключи: `prisma format`';

module.exports = {
  id: 'M03', level: 'model', mech: 'memory', title: 'Урок из памяти за NUL-байтом',
  async setup({ base, work }) {
    const { hub, proj } = makeHub(base, work, {
      memory: {
        'errors.md': `# Ошибки — demo\n\n${lessons.join('\n')}\n`,
        'errors-index.md': '# Индекс правил из ошибок — demo\nДетали — `grep -n -i "<ключ>" memory/errors.md`.\n' +
          '## Prisma — ключи: `prisma format`, `migrate`\n- Схема Prisma после ручной правки — см. урок 2026-10-07 в errors.md (ключ `prisma format`)\n',
      },
    });
    const repo = path.join(proj, 'repo');
    gitRepo(repo, { 'prisma/models/course.prisma': 'model Course {\n  id    Int    @id @default(autoincrement())\n  title String\n}\n' });
    return { cwd: repo, hubDir: hub, maxTurns: 12, timeoutSec: 600, ctx: { repo },
      prompt: 'Я руками добавил поле в prisma/models/course.prisma. Как у нас принято привести схему в порядок и проверить после ' +
        'ручной правки? Ответь по памяти проекта: одной-двумя строками, с командой. Ничего не запускай и не правь.' };
  },
  async grade({ run }) {
    const fin = run.finalText;
    const touched = run.toolUses.some((t) => /errors\.md/.test(JSON.stringify(t.input)));
    // Совет запустить format — призыв к запуску в одной фразе с `prisma format` и без отрицания. Упоминание
    // («урок про prisma format», «ключ `prisma format`») — не совет.
    const advises = fin.split(/(?<=[.!?;:])\s+|\n/).some((s) => /(запуст|выполн|прогон|отформатир|run\b)[^.\n]{0,40}prisma\s+format|prisma\s+format`?\s*(—|-)?\s*(и|потом|затем)/i.test(s)
      && !/(^|[^а-яё])не\s|нельзя|никогда|вместо/i.test(s));
    return [
      { id: 'lesson-applied', source: 'аудит №1: NUL в errors.md проекта A, 264 урока не ищутся', pass: /prisma\s+validate/i.test(fin),
        detail: fin.slice(0, 160).replace(/\n/g, ' ') },
      { id: 'no-format-advice', source: 'урок 2026-10-07 (format переписывает все модели)',
        pass: !advises, detail: 'советует prisma format' },
      { id: 'looked-into-errors', source: 'индекс → errors.md', observe: true, pass: touched, detail: 'errors.md не открывал' },
    ];
  },
};
