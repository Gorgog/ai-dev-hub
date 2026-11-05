// memory-write-check (handler memory): a lesson or decision written by Write/Edit is validated at once (the validator
// of memory v2) — block with the problems; .triggers.json follows the files. Library: ../memory-hooks.cjs.
'use strict';
const { checkWrite } = require('../memory-hooks.cjs');

module.exports = {
  id: 'memory-write-check',
  run(ev, ctx = {}) {
    return checkWrite(ev, ctx);
  },
};
