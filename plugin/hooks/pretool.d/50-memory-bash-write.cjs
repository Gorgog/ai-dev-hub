// memory-bash-write (handler memory): in a project with memory v2, Bash never writes memory/lessons/** or decisions/** —
// such a write skips the check of a lesson. Deny with how to write one (Write/Edit, recall). Library: ../memory-hooks.cjs.
'use strict';

module.exports = {
  id: 'memory-bash-write',
  run(ev, ctx = {}) {
    // The library is loaded only for a command that names lessons/, decisions/ or memory: a cold require costs ≈ 4 ms a call.
    const cmd = ev.tool_name === 'Bash' && ev.tool_input && ev.tool_input.command;
    if (typeof cmd !== 'string' || !/lessons|decisions|memory/.test(cmd)) return null;
    return require('../memory-hooks.cjs').bashWrite(ev, ctx);
  },
};
