// Скиллы хаба срабатывают по русским фразам пользователя, диспетчер — нет; на простой вопрос — без скиллов.
// Четыре варианта одной идеи — четыре коротких прогона: нужен только первый вызов Skill, ходов мало.
'use strict';
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');

const PRICE = "'use strict';\nfunction total(items) { return items.reduce((s, it) => s + it.price * it.qty, 0); }\nmodule.exports = { total };\n";
const TEST = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../src/price.js');\n" +
  "test('сумма', () => assert.strictEqual(total([{ price: 100, qty: 2 }]), 250));\n";
const SRC = 'platform C1 (скиллы по фразам); правила 1, 11 (оценка — только /hub:estimate)';

const VARIANTS = [
  ['M04-estimate', /(^|:)estimate$/, 'Оцени задачу: добавить в apps/shop выгрузку заказов в CSV — сколько займёт и какая сложность?'],
  ['M04-checks', /(^|:)checks$/, 'Прогони проверки по моим изменениям в apps/shop.'],
  ['M04-debug', /(^|:)debug$/, 'Падает тест apps/shop/test/price.test.js, не пойму почему. Разберись.'],
  ['M04-negative', null, 'Что возвращает функция total в apps/shop/src/price.js? Ответь одной строкой, ничего не запускай.'],
];

const skillsOf = (run) => run.toolUses.filter((t) => t.name === 'Skill').map((t) => String(t.input.skill || t.input.command || '?'));

module.exports = VARIANTS.map(([id, skill, prompt]) => ({
  id, level: 'model', mech: 'skills', title: `Скилл по фразе: ${skill ? skill.source : 'без скилла'}`, skill,
  async setup({ base, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    const git = gitRepo(repo, {
      'apps/shop/package.json': JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node --test test/' } }, null, 2) + '\n',
      'apps/shop/src/price.js': PRICE, 'apps/shop/test/price.test.js': TEST,
    });
    git('checkout', '-q', '-b', 'DEMO-40');
    return { cwd: repo, hubDir: hub, prompt, maxTurns: 6, maxBudgetUsd: 1, timeoutSec: 300, ctx: { repo } };
  },
  async grade({ run }) {
    const called = skillsOf(run);
    const checks = [{ id: 'no-dispatch', kind: 'quiet', source: SRC, pass: !called.some((s) => /dispatch/.test(s)), detail: called.join(',') }];
    if (skill) checks.unshift({ id: 'skill-called', kind: 'catch', source: SRC, pass: called.some((s) => skill.test(s)), detail: called.join(',') || 'Skill не вызван' });
    else checks.unshift({ id: 'no-skill', kind: 'quiet', source: SRC, pass: called.length === 0, detail: called.join(',') });
    checks.push({ id: 'turns', source: 'стоимость', observe: true, pass: true, detail: `${run.turns} ходов, $${run.costUsd.toFixed(2)}` });
    return checks;
  },
}));
