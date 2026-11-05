// The dispatcher's resource lock (skills/dispatch/scripts/guard.cjs, owned by slice 15): a heavy or medium call in a
// worktree of a hub project needs a grant, else it is blocked — exit 2 with the reason, as in v1. An error inside
// decide() (say, a broken dispatch-rules.json) passes the call, as in v1: the brief's preflight names the broken
// config. The spine's fail-closed is for a broken module — this file not loading or breaking the contract.
'use strict';
const { decide } = require('../../skills/dispatch/scripts/guard.cjs');

module.exports = {
  id: 'lock',
  run(ev) {
    let lock = null;
    try { lock = decide(ev); } catch { return null; }
    return lock ? { decision: 'block', reason: lock.reason } : null;
  },
};
