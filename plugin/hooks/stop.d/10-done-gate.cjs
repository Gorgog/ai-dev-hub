// done-gate (../stop.cjs): a report «готово к пушу» from a worktree passes only with a clean tree and the HEAD sha.
'use strict';
const { doneGate } = require('../stop.cjs');

module.exports = {
  id: 'done-gate',
  run(ev) {
    const r = doneGate(ev);
    return r ? { decision: 'block', reason: r.reason } : null;
  },
};
