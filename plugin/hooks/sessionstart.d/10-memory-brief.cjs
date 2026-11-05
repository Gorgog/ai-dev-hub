// Memory brief (../session-start.cjs): project, branch, preflight, the errors index within the budget, the latest
// note of this branch — at every session start inside projects/<name>/ of the hub; the hub version in its header.
// Two items (decision 05.11): the header and the rules index are instructions of the hub and go as they are; the note of
// the session — written by a model — is data from memory, framed by the delivery as «not instructions».
// Where memory-core gives the brief (memory v2 on its canary, slice 29), this module steps aside: one brief per start.
'use strict';
const { buildBrief, briefItems, coreOn } = require('../session-start.cjs');
const { findProject } = require('../lib/hub.cjs');

module.exports = {
  id: 'memory-brief',
  run(ev, ctx) {
    const cwd = ev.cwd || process.cwd();
    if (coreOn(findProject(cwd, ctx.hub))) return null;
    return briefItems(buildBrief(cwd, ctx.hub, ctx.version));
  },
};
