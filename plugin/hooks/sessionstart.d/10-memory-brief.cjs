// Memory brief (../session-start.cjs): project, branch, preflight, the errors index within the budget, the latest
// note of this branch — at every session start inside projects/<name>/ of the hub; the hub version in its header.
'use strict';
const { buildBrief } = require('../session-start.cjs');

module.exports = {
  id: 'memory-brief',
  run(ev, ctx) {
    const brief = buildBrief(ev.cwd || process.cwd(), ctx.hub, ctx.version);
    return brief ? { items: [{ text: brief, priority: 'info', key: 'memory-brief' }] } : null;
  },
};
