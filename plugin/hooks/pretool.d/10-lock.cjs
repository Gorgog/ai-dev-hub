// The dispatcher's resource lock (skills/dispatch/scripts/guard.cjs, owned by slice 15): a heavy or medium call in a
// worktree of a hub project needs a grant, else it is blocked — exit 2 with the reason, as in v1. An error inside
// decide() (say, a broken dispatch-rules.json) passes the call, as in v1: the brief's preflight names the broken
// config. The spine's fail-closed is for a broken module — this file not loading or breaking the contract.
// This module judges by the text of the command (v1). Where lock-program (11-lock-program.cjs, by program) is live
// by its stage, this one steps aside: one lock decides, never both.
'use strict';
const path = require('path');
const { decide, programLockActive } = require('../../skills/dispatch/scripts/guard.cjs');

const PLUGIN = path.resolve(__dirname, '..', '..');

module.exports = {
  id: 'lock',
  run(ev, ctx = {}) {
    if (programLockActive(PLUGIN, ctx.project || null)) return null;
    let lock = null;
    try { lock = decide(ev); } catch { return null; }
    return lock ? { decision: 'block', reason: lock.reason } : null;
  },
};
