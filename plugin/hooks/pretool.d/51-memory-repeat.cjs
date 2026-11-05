// memory-repeat (handler memory): a lesson already delivered to this agent in this epoch fires again before a call —
// the same mistake is about to repeat: deny once with the lesson (decision 05.11 on P10). Library: ../memory-hooks.cjs.
'use strict';
const { repeatBefore } = require('../memory-hooks.cjs');

module.exports = {
  id: 'memory-repeat',
  run(ev, ctx = {}) {
    return repeatBefore(ev, ctx);
  },
};
