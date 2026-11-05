// memory-bash-write (handler memory): in a project with memory v2, Bash never writes memory/lessons/** or decisions/** —
// such a write skips the check of a lesson. Deny with how to write one (Write/Edit, recall). Library: ../memory-hooks.cjs.
'use strict';
const { bashWrite } = require('../memory-hooks.cjs');

module.exports = {
  id: 'memory-bash-write',
  run(ev, ctx = {}) {
    return bashWrite(ev, ctx);
  },
};
