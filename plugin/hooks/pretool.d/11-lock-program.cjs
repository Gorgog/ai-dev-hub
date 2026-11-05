// The dispatcher's resource lock judged by program (slice 15): guard.decide(ev, { by: 'program' }) — what the Bash
// command really runs, after shell is read (wrappers, env, npx, subshells, variables, scripts), not the words of its
// text. Rolled out by its own stage (plugin/mechanisms/lock-program.json: canary → on); where it is live, 10-lock
// (by text) steps aside, at «off» 10-lock decides as before. An error inside the program reading falls back to the
// text decision, an error there passes the call — as 10-lock and v1.
'use strict';
const { decide } = require('../../skills/dispatch/scripts/guard.cjs');

module.exports = {
  id: 'lock-program',
  run(ev) {
    let lock = null;
    try { lock = decide(ev, { by: 'program' }); } catch {
      try { lock = decide(ev); } catch { return null; }
    }
    return lock ? { decision: 'block', reason: lock.reason } : null;
  },
};
