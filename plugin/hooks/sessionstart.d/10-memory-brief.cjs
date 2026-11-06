// Memory brief (../session-start.cjs): project, branch, preflight, the errors index within the budget, the latest
// note of this branch — at every session start inside projects/<name>/ of the hub; the hub version in its header.
// Two items (decision 05.11): the header and the rules index are instructions of the hub and go as they are; the note of
// the session — written by a model — is data from memory, framed by the delivery as «not instructions».
// Where 09-memory-core gave the brief for this very event (memory v2 on its canary, slice 29), this module steps aside:
// one brief per start.
'use strict';
const { buildBrief, briefItems, coreGiven } = require('../session-start.cjs');

module.exports = {
  id: 'memory-brief',
  run(ev, ctx) {
    if (coreGiven.has(ev)) return null;
    return briefItems(buildBrief(ev.cwd || process.cwd(), ctx.hub, ctx.version));
  },
};
