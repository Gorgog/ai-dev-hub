// note-stub-end (../../lib/note-stub.cjs, handler done-gate): a session that worked and ends without /hub:wind-down
// leaves a stub note in memory/sessions/ of its project. Nothing reaches Claude: the session is over.
'use strict';
const { atEnd } = require('../../lib/note-stub.cjs');

module.exports = {
  id: 'note-stub-end',
  run(ev, ctx) { atEnd(ev, ctx.project); return null; },
};
