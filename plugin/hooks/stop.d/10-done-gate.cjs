// done-gate (../stop.cjs, v1): a report «готово к пушу» from a worktree passes only with a clean tree and the HEAD sha.
// Where the new judging is on the canary (../../lib/done-gate.cjs canaryOn) it steps aside: stop.d/11-done-facts.cjs
// judges the report by facts there. R2 staging: hub → project B → all; the canary entry is the switch.
'use strict';
const { doneGate } = require('../stop.cjs');
const { canaryOn } = require('../../lib/done-gate.cjs');

module.exports = {
  id: 'done-gate',
  run(ev, ctx) {
    if (canaryOn(ctx.project)) return null;
    const r = doneGate(ev, ctx.hub || undefined);
    return r ? { decision: 'block', reason: r.reason } : null;
  },
};
