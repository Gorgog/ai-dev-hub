// Memory core (slice 29, canary): in a project with memory v2 (memory/lessons/) the brief carries the core of lessons
// (status core, ≤ 15 lines: the first line and the id) instead of the hand-written errors index; the rest of the lessons
// comes by touch (the lesson hooks) and /hub:recall. Header, preflight and the note of the branch — as in memory-brief,
// which steps aside here. The core is the project's rules — like the index, no frame; the note is framed.
'use strict';
const { buildBrief, briefItems, coreOn } = require('../session-start.cjs');
const { findProject } = require('../lib/hub.cjs');

module.exports = {
  id: 'memory-core',
  run(ev, ctx) {
    const cwd = ev.cwd || process.cwd();
    if (!coreOn(findProject(cwd, ctx.hub))) return null;
    return briefItems(buildBrief(cwd, ctx.hub, ctx.version, { core: true }));
  },
};
