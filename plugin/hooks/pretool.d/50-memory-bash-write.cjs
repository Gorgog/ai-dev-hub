// memory-bash-write (handler memory): in a project with memory v2, Bash never writes memory/lessons/** or decisions/** —
// such a write skips the check of a lesson. Deny with how to write one (Write/Edit, recall). Library: ../memory-hooks.cjs.
'use strict';

module.exports = {
  id: 'memory-bash-write',
  run(ev, ctx = {}) {
    // The library is loaded only for a command that names the memory or removes / moves something (GATE of
    // memory-hooks.cjs, kept in step by its test): a cold require costs ≈ 4 ms a call.
    const cmd = ev.tool_name === 'Bash' && ev.tool_input && ev.tool_input.command;
    if (typeof cmd !== 'string' || !/lessons|decisions|memory|\b(?:rm|rmdir|shred|mv|find)\b/.test(cmd)) return null;
    return require('../memory-hooks.cjs').bashWrite(ev, ctx);
  },
};
