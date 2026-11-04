// Явная мелочь: опечатка в README. Хаб не должен превращать её в ритуал (план-режим, оценка, вопрос о режиме,
// ревью) — правило 1 «явная мелочь — на глаз»; исследование AGENTS.md: лишние требования дорожают прогон на 20 %+.
'use strict';
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { gitIn } = require('../lib/grade.cjs');

module.exports = {
  id: 'M02', level: 'model', title: 'Опечатка без ритуала',
  async setup({ base, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    const git = gitRepo(repo, { 'README.md': '# shop\n\n## Instalation\n\nRun `npm install`, then `npm test`.\n' });
    git('checkout', '-q', '-b', 'DEMO-13');
    return { cwd: repo, hubDir: hub, maxTurns: 15, maxBudgetUsd: 1.5, timeoutSec: 600, ctx: { repo },
      prompt: 'В README опечатка: «Instalation» вместо «Installation». Поправь и закоммить.' };
  },
  ctxFromWork: (work) => ({ repo: path.join(work, 'hub', 'projects', 'demo', 'repo') }),
  async grade({ run, ctx }) {
    const git = gitIn(ctx.repo);
    const readme = git('show', 'HEAD:README.md') || '';
    const names = run.toolUses.map((t) => t.name);
    const skills = run.toolUses.filter((t) => t.name === 'Skill').map((t) => t.input.skill || t.input.command || '?');
    const agents = run.toolUses.filter((t) => t.name === 'Agent' || t.name === 'Task').map((t) => t.input.subagent_type || '?');
    return [
      { id: 'fixed-and-committed', source: 'задача', pass: /Installation/.test(readme) && !/Instalation/.test(readme)
        && (git('status', '--porcelain') || '') === '', detail: readme.split('\n')[2] || 'нет README в HEAD' },
      { id: 'no-plan-mode', source: 'правило 1 (явная мелочь — на глаз)', pass: !names.includes('EnterPlanMode'), detail: 'вошёл в план-режим' },
      { id: 'no-estimate-dispatch', source: 'правила 1, 11', pass: !skills.some((s) => /estimate|dispatch/.test(s)), detail: skills.join(',') },
      { id: 'no-mode-question', source: '«Многосессионная работа» (мелкую — одной сессией)', pass: !/многосесси/i.test(run.allText),
        detail: 'спросил «одна сессия или многосессионно»' },
      { id: 'reviewer-called', source: 'правило 8', observe: true, pass: !agents.length, detail: agents.join(',') },
      { id: 'turns', source: 'стоимость', observe: true, pass: run.turns <= 8, detail: `${run.turns} ходов, $${run.costUsd.toFixed(2)}` },
    ];
  },
};
