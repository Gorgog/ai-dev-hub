// memory-write-check (handler memory): a lesson or decision written by Write/Edit is validated at once (the validator
// of memory v2) — block with the problems; .triggers.json follows the files. Library: ../memory-hooks.cjs.
'use strict';

module.exports = {
  id: 'memory-write-check',
  run(ev, ctx = {}) {
    // The library is loaded only for a write whose path names lessons/ or decisions/.
    const file = ev.tool_input && ev.tool_input.file_path;
    if (typeof file !== 'string' || !/lessons|decisions/.test(file)) return null;
    return require('../memory-hooks.cjs').checkWrite(ev, ctx);
  },
};
