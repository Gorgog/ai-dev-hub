// done-facts (../../lib/done-gate.cjs, handler done-gate): after done-gate passed a report, the facts behind it —
// `checks.cjs --full` green on the final HEAD of a clean tree (projects with checks.json), a push report from a
// branch that is not behind its base. Any commit after the full run (docs, plan) needs a new run: slice 11 found
// 35 of 59 reports without one.
'use strict';
const path = require('path');
const { isReport, target, facts } = require('../../lib/done-gate.cjs');

const CHECKS = path.join(__dirname, '..', '..', 'skills', 'checks', 'scripts', 'checks.cjs');

module.exports = {
  id: 'done-facts',
  run(ev, ctx) {
    if (ev.stop_hook_active || !ctx.project) return null;
    const text = ev.last_assistant_message || '';
    const kind = isReport(text);
    if (!kind) return null;
    const wt = target(ev.cwd, text, ctx.project);
    const problems = wt ? facts(wt, ctx.project, kind) : [];
    if (!problems.length) return null;
    return { decision: 'block', reason: `«Готово к ${kind === 'push' ? 'пушу' : 'мержу'}» не проходит (правило 3 хаба): ${problems.join('; ')}. `
      + `Полный прогон — последним шагом, после последнего коммита (и доков): node ${CHECKS} --full в ${wt}, затем доклад заново.` };
  },
};
