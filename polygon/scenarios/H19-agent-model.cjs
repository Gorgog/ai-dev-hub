// agent-model: hub:reviewer на модели не Opus — deny с вызовом без model (правило 8: модель задаёт reviewer.md).
// Журналы проекта A до 05.11: 33 вызова ревьюера на fable из ~470.
'use strict';
const { judge, cases } = require('./H17-protect-files.cjs');

const R8 = 'правило 8 хаба';
const call = (subagent_type, model) => ({ description: 'review', prompt: 'дифф main..HEAD', subagent_type, ...(model ? { model } : {}) });
// [id, tool, input, expectDeny, source]
const CORPUS = [
  ['reviewer-sonnet', 'Agent', call('hub:reviewer', 'sonnet'), true, R8],
  ['reviewer-fable-task', 'Task', call('reviewer', 'fable'), true, `${R8}; журналы проекта A (reviewer, model fable)`],
  ['reviewer-haiku', 'Agent', call('hub:reviewer', 'haiku'), true, R8],
  ['reviewer-default', 'Agent', call('hub:reviewer'), false, `${R8}: model из reviewer.md`],
  ['reviewer-opus', 'Agent', call('reviewer', 'opus'), false, 'журналы проекта A: 233 вызова reviewer с model opus'],
  ['general-haiku', 'Agent', call('general-purpose', 'haiku'), false, 'не ревьюер'],
  ['explore-sonnet', 'Agent', call('Explore', 'sonnet'), false, 'не ревьюер'],
];

module.exports = {
  id: 'H19', level: 'hook', mech: 'agent-model', title: 'agent-model: ревьюер только на Opus', CORPUS,
  async run(ctx) { return judge('agent-model', cases(CORPUS, 'H19'), ctx, /без model/); },
};
