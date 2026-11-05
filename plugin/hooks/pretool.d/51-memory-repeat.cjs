// memory-repeat (handler memory): a lesson already delivered to this agent in this epoch fires again before a call —
// the same mistake is about to repeat: deny once with the lesson (decision 05.11 on P10). Library: ../memory-hooks.cjs.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'memory-repeat',
  run(ev, ctx = {}) {
    // Most calls end here, before the library loads (a cold require costs ms on every call): no delivery state, no
    // memory v2, or no lesson delivered to this agent in this epoch yet — nothing can repeat.
    if (!ctx.delivery || !ev.session_id || !ctx.project) return null;
    try { if (!fs.statSync(path.join(ctx.project.dir, 'memory', 'lessons')).isDirectory()) return null; } catch { return null; }
    const session = require('../lib/session.cjs');
    const a = session.read(ev.session_id).agents[session.agentOf(ev)];
    if (!a || a.epoch !== ctx.epoch || !a.shown || !Object.keys(a.shown).some((k) => k.startsWith('lesson:'))) return null;
    return require('../memory-hot.cjs').repeatBefore(ev, ctx);
  },
};
