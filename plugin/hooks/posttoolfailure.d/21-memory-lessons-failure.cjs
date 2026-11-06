// memory-lessons-failure (handler memory, slice 37): the lessons whose `when` fires on a failed call come right after
// it — `out` is the text of the error (fieldsOf in ../memory-hot.cjs), once per epoch with the lessons after finished
// calls, through the delivery. Same library and state as posttool.d/21-memory-lessons.cjs.
'use strict';
const { lessonsAfter } = require('../memory-hot.cjs');

module.exports = {
  id: 'memory-lessons-failure',
  run(ev, ctx = {}) {
    return lessonsAfter(ev, ctx);
  },
};
