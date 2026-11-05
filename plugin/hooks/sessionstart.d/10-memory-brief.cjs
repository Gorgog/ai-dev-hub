// Memory brief (../session-start.cjs): project, branch, preflight, the errors index within the budget, the latest
// note of this branch — at every session start inside projects/<name>/ of the hub; the hub version in its header.
// Two items (decision 05.11): the header and the rules index are instructions of the hub and go as they are; the note of
// the session — written by a model — is data from memory, framed by the delivery as «not instructions».
'use strict';
const { buildBrief } = require('../session-start.cjs');

// Where the note's part of the brief begins: buildBrief puts it last. The first match: a rules index quoting this
// line only moves more text into the frame, never a note's text out of it.
const NOTE = '\nПоследняя заметка этой ветки: ';

module.exports = {
  id: 'memory-brief',
  run(ev, ctx) {
    const brief = buildBrief(ev.cwd || process.cwd(), ctx.hub, ctx.version);
    if (!brief) return null;
    const at = brief.indexOf(NOTE);
    if (at < 0) return { items: [{ text: brief, priority: 'info', key: 'memory-brief' }] };
    return { items: [
      { text: brief.slice(0, at), priority: 'info', key: 'memory-brief' },
      { text: brief.slice(at + 1), priority: 'info', key: 'memory-brief-note', source: 'memory' },
    ] };
  },
};
