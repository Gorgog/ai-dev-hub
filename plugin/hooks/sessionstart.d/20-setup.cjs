// Local settings of the hub (../../skills/setup/scripts/setup.cjs): at a session start, say how many are missing on
// this machine and in this project and that /hub:setup sets them, one confirmed call each. Silent when none is
// missing and after a compaction (the session was told at its start). A setting the check cannot read here (no git,
// a broken settings file) is not counted: /hub:setup shows it as «?».
'use strict';
const { check, missingOf, summary } = require('../../skills/setup/scripts/setup.cjs');

module.exports = {
  id: 'setup',
  run(ev, ctx) {
    if (ev.source === 'compact') return null;
    const list = check({ cwd: ev.cwd || process.cwd(), hub: ctx.hub });
    const lack = missingOf(list);
    if (!lack.length) return null;
    return { items: [{ text: `Хаб: ${summary(list)} (${lack.map((c) => c.id).join(', ')}) — /hub:setup ставит каждую с подтверждением.`,
      priority: 'reminder', key: 'setup' }] };
  },
};
