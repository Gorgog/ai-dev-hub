// Механизмы среза 13 на чужом корпусе: команды H02 (замок) и H03 (rules-guard) — синтетика и реальные корпуса —
// проходят у основной сессии без единого deny protect-files / inline-script / agent-model / agent-roles. Решения замка
// и rules-guard здесь не судятся. Роли (ревьюеру запись в репозиторий запрещена) — H20.
'use strict';
const H02 = require('./H02-lock-by-command-text.cjs');
const H03 = require('./H03-rules-guard-reminders.cjs');
const { judge } = require('./H17-protect-files.cjs');
const { realCorpus } = require('../lib/corpus.cjs');

function corpus() {
  const calls = [
    ...H02.CORPUS.map(([id, tool, input]) => ({ id: `H02:${id}`, tool, input, source: 'корпус H02' })),
    ...H03.CORPUS.map(([id, command]) => ({ id: `H03:${id}`, tool: 'Bash', input: { command }, source: 'корпус H03' })),
    ...(realCorpus('H02') || []).map((c) => ({ id: `H02:${c.id}`, tool: c.tool, input: c.input, source: c.source, real: true })),
    ...(realCorpus('H03') || []).map((c) => ({ id: `H03:${c.id}`, tool: 'Bash', input: { command: c.command }, source: c.source, real: true })),
  ];
  return calls.map((c) => ({ ...c, expect: false }));
}

module.exports = {
  id: 'H21', level: 'hook', mech: 'protect', title: 'Механизмы среза 13: без ложных блоков на корпусе H02/H03',
  async run(ctx) { return judge('protect', corpus(), ctx); },
};
