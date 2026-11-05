// memory-commit (handler memory): lesson events of the session → memory/events of the project, then the memory's git
// commits lessons/, decisions/, events/ under flock -n (P14: busy — skip). Never blocks. Library: ../memory-hooks.cjs.
'use strict';
const { stop } = require('../memory-hooks.cjs');

module.exports = {
  id: 'memory-commit',
  run(ev, ctx = {}) {
    return stop(ev, ctx);
  },
};
