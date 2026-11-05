// done-gate (../../lib/done-gate.cjs): a report «готово к пушу» — a line that starts with the phrase, not a mention —
// passes only with a clean tree of the copy it is about and a sha of its HEAD in the text (hub rule 3).
'use strict';
const { isReport, target, basics } = require('../../lib/done-gate.cjs');

module.exports = {
  id: 'done-gate',
  run(ev, ctx) {
    if (ev.stop_hook_active) return null;
    const text = ev.last_assistant_message || '';
    const kind = isReport(text);
    if (!kind) return null;
    const wt = target(ev.cwd, text, ctx.project);
    const problems = wt ? basics(text, wt) : [];
    if (!problems.length) return null;
    return { decision: 'block', reason: `«Готово к ${kind === 'push' ? 'пушу' : 'мержу'}» не проходит (правило 3 хаба): ${problems.join('; ')}. `
      + 'Закоммить, прогони проверки на итоговом HEAD и повтори доклад с его sha.' };
  },
};
