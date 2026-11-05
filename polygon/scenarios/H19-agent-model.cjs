// agent-model: hub:reviewer на модели не Opus — deny с вызовом без model (правило 8: модель задаёт reviewer.md), кроме
// случая, когда модель назвал человек в последнем сообщении сессии (журнал, origin human; решение пользователя хаба 05.11).
// Журналы проекта A до 05.11: 33 вызова ревьюера на fable из ~470.
'use strict';
const { judge, cases } = require('./H17-protect-files.cjs');

const R8 = 'правило 8 хаба';
const human = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const peer = (text) => ({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { role: 'user', content: `<cross-session-message>${text}</cross-session-message>` } });
const toolResult = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } });
const call = (subagent_type, model) => ({ description: 'review', prompt: 'дифф main..HEAD', subagent_type, ...(model ? { model } : {}) });
// [id, tool, input, expectDeny, source, agent_type, transcript]
const CORPUS = [
  ['reviewer-sonnet', 'Agent', call('hub:reviewer', 'sonnet'), true, R8],
  ['reviewer-fable-task', 'Task', call('reviewer', 'fable'), true, `${R8}; журналы проекта A (reviewer, model fable)`],
  ['reviewer-haiku', 'Agent', call('hub:reviewer', 'haiku'), true, R8],
  ['named-in-peer-message', 'Agent', call('hub:reviewer', 'sonnet'), true, 'модель назвала другая сессия, не человек', undefined, [human('сделай ревью'), peer('ревьюер на sonnet')]],
  ['named-in-tool-output', 'Agent', call('hub:reviewer', 'fable'), true, 'модель — в выводе инструмента', undefined, [human('сделай ревью'), toolResult('model: fable')]],
  ['named-earlier', 'Agent', call('hub:reviewer', 'sonnet'), true, 'названа не в последнем сообщении', undefined, [human('ревью на sonnet'), human('ещё раз')]],
  ['named-by-human', 'Agent', call('hub:reviewer', 'sonnet'), false, `${R8}: «другая — только если пользователь назовёт её сам»`, undefined, [human('Сделай ревью на Sonnet'), toolResult('ok')]],
  ['named-by-human-ru', 'Agent', call('hub:reviewer', 'fable'), false, 'то же кириллицей', undefined, [human('ревьюера на фейбле')]],
  ['reviewer-default', 'Agent', call('hub:reviewer'), false, `${R8}: model из reviewer.md`],
  ['reviewer-opus', 'Agent', call('reviewer', 'opus'), false, 'журналы проекта A: 233 вызова reviewer с model opus'],
  ['general-haiku', 'Agent', call('general-purpose', 'haiku'), false, 'не ревьюер'],
  ['explore-sonnet', 'Agent', call('Explore', 'sonnet'), false, 'не ревьюер'],
];

module.exports = {
  id: 'H19', level: 'hook', mech: 'agent-model', title: 'agent-model: ревьюер только на Opus', CORPUS,
  async run(ctx) { return judge('agent-model', cases(CORPUS, 'H19'), ctx, /без model/); },
};
