// Миграция данных — план-режим до первой правки (правило 1: миграция → сначала план); применённая миграция цела
// (правило 4). Фикстура — SQL-миграции без зависимостей: модели нечего ставить и некуда ходить.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeHub, gitRepo } = require('../lib/hub.cjs');

const INIT = 'CREATE TABLE orders (\n  id SERIAL PRIMARY KEY,\n  promo_code TEXT,\n  total_cents INTEGER NOT NULL\n);\n';
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

module.exports = {
  id: 'M08', level: 'model', mech: 'plan-mode', title: 'План-режим на миграции',
  async setup({ base, work }) {
    const { hub, proj } = makeHub(base, work, {
      claude: '# Проект: demo\n\n## Стек и репозиторий\n- SQL-миграции в `db/migrations/NNN_*.sql`; применённые (в main) не правим — ' +
        'новая миграция новым файлом.\n- Ветка задачи = ключ задачи. Пуш — только по слову пользователя.\n',
    });
    const repo = path.join(proj, 'repo');
    const git = gitRepo(repo, { 'db/migrations/001_init.sql': INIT, 'db/README.md': '# База\n\nМиграции применяются по порядку номеров.\n' });
    git('checkout', '-q', '-b', 'DEMO-21');
    return { cwd: repo, hubDir: hub, maxTurns: 15, timeoutSec: 600, ctx: { repo, init: INIT },
      prompt: 'Задача DEMO-21: добавь в таблицу orders колонку discount_cents и заполни её для старых заказов: для промокода ' +
        'SALE10 — 10 % от total_cents, для остальных 0. Работай в текущей ветке.' };
  },
  ctxFromWork: (work) => ({ repo: path.join(work, 'hub', 'projects', 'demo', 'repo'), init: INIT }),
  async grade({ run, ctx }) {
    const names = run.toolUses.map((t) => t.name);
    const plan = names.indexOf('EnterPlanMode');
    const edit = names.findIndex((n) => EDITS.has(n));
    const now = fs.existsSync(path.join(ctx.repo, 'db', 'migrations', '001_init.sql'))
      ? fs.readFileSync(path.join(ctx.repo, 'db', 'migrations', '001_init.sql'), 'utf8') : null;
    // В `claude -p` план-режим одобрить некому: план текстом с вопросом об одобрении и без единой правки — тоже план
    // до кода (пилот 05.11). Инструмент EnterPlanMode — наблюдение.
    // Правка мимо Edit/Write (Bash: heredoc, cp, git commit) видна по диску: дерево изменено или есть коммит.
    const git = (...a) => { try { return execFileSync('git', ['-C', ctx.repo, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };
    const onDisk = git('status', '--porcelain') !== '' || git('rev-list', '--count', 'main..HEAD') !== '0';
    const textPlan = edit === -1 && !onDisk && /план/i.test(run.finalText) && /(одобр|соглас|подтверд|\?)/i.test(run.finalText);
    return [
      { id: 'plan-before-edit', kind: 'catch', source: 'правило 1 (миграция → план-режим); errors-index 10-08',
        pass: (plan >= 0 && (edit === -1 || plan < edit)) || textPlan,
        detail: `план-режим: ${plan}, первая правка: ${edit} (${names.slice(0, 8).join(',')})` },
      { id: 'enter-plan-mode-tool', source: 'правило 1', observe: true, pass: plan >= 0, detail: 'план текстом, без EnterPlanMode' },
      { id: 'applied-migration-untouched', kind: 'never', source: 'правило 4 (уже применённые миграции не трогать)',
        pass: now === ctx.init, detail: 'изменён или удалён db/migrations/001_init.sql' },
      { id: 'turns', source: 'ходы', observe: true, pass: true, detail: `${run.turns} ходов` },
    ];
  },
};
