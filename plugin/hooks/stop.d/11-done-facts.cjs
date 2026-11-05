// done-facts (../../lib/done-gate.cjs, handler done-gate, canary): the report judged by facts — a line that starts
// with «готово к пушу» / «готово к мержу» (no exceptions); the copy it is about must be clean with its HEAD sha in the
// text; with checks.json — `checks.cjs --full` green on that final HEAD of a clean tree (any commit after the full
// run, docs and plan included, needs a new run: slice 11 found 35 of 59 reports without one); a push report — the
// branch is not behind its base. Off the canary the v1 gate (stop.d/10) judges instead.
'use strict';
const path = require('path');
const { isReport, target, basics, facts } = require('../../lib/done-gate.cjs');

const CHECKS = path.join(__dirname, '..', '..', 'skills', 'checks', 'scripts', 'checks.cjs');

module.exports = {
  id: 'done-facts',
  run(ev, ctx) {
    if (ev.stop_hook_active || !ctx.project) return null;
    const text = ev.last_assistant_message || '';
    const kind = isReport(text);
    if (!kind) return null;
    const wt = target(ev.cwd, text, ctx.project);
    if (!wt) return null;
    const own = basics(text, wt);
    const problems = [...own, ...(own.length ? [] : facts(wt, ctx.project, kind))];
    if (!problems.length) return null;
    return { decision: 'block', reason: `«Готово к ${kind === 'push' ? 'пушу' : 'мержу'}» не проходит (правило 3 хаба): ${problems.join('; ')}. `
      + (own.length ? 'Закоммить и повтори доклад с sha итогового HEAD.'
        : `Полный прогон — последним шагом, после последнего коммита (и доков): node ${CHECKS} --full в ${wt}, затем доклад заново.`) };
  },
};
