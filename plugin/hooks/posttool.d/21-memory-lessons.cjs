// memory-lessons (handler memory): the lessons whose `when` fires on the finished call come right after it, once per
// epoch, through the delivery (decision 05.11 on P10). Library: ../memory-hooks.cjs.
'use strict';
const { lessonsAfter } = require('../memory-hooks.cjs');

module.exports = {
  id: 'memory-lessons',
  run(ev, ctx = {}) {
    return lessonsAfter(ev, ctx);
  },
};
