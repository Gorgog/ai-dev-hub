// memory-check (handler memory): SessionStart names every corruption of memory v2 (store.check: NUL, schema, torn
// event lines, a broken index — rebuilt) and blocks nothing. Library: ../memory-hooks.cjs.
'use strict';
const { preflight } = require('../memory-hooks.cjs');

module.exports = {
  id: 'memory-check',
  run(ev, ctx = {}) {
    return preflight(ev, ctx);
  },
};
