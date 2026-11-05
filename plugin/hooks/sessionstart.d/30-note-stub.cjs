// note-stub-start (../../lib/note-stub.cjs, handler done-gate): when the SessionEnd of the previous session of this
// folder did not leave its stub (or its note), the new session writes it and is reminded to sum that session up.
'use strict';
const { atStart } = require('../../lib/note-stub.cjs');

module.exports = {
  id: 'note-stub-start',
  run(ev, ctx) {
    const r = atStart(ev, ctx.project);
    return r ? { items: [{ text: r.text, priority: 'reminder', key: 'note-stub' }] } : null;
  },
};
