// Memory core (slice 29, canary): in a project with memory v2 (memory/lessons/) the brief carries the core of lessons
// (status core, ≤ 15 lines: the first line and the id) instead of the hand-written errors index; the rest of the lessons
// comes by touch (the lesson hooks) and /hub:recall. Header, preflight and the note of the branch — as in memory-brief.
// The core is the project's rules — like the index, no frame; the note is framed.
// Runs before 10-memory-brief and marks the event it gave the brief for: memory-brief steps aside only for that event
// (one decision per start, ../session-start.cjs coreGiven). The project — by ev.cwd only, as the spine finds it.
'use strict';
const { buildBrief, briefItems, coreOn, coreGiven } = require('../session-start.cjs');
const { findProject } = require('../lib/hub.cjs');

module.exports = {
  id: 'memory-core',
  run(ev, ctx) {
    if (!ev.cwd || !coreOn(findProject(ev.cwd, ctx.hub))) return null;
    const res = briefItems(buildBrief(ev.cwd, ctx.hub, ctx.version, { core: true }));
    if (res) coreGiven.add(ev);
    return res;
  },
};
