// estimate-marks: the marks «⏱ EST-START/END <KEY>» of the turn — in Claude's text, in its messages to the dispatcher
// mid-turn (the tail of the transcript), in the last message — go to the project's index memory/est-marks.jsonl
// (skills/estimate/scripts/marks.cjs). session-time.cjs `key` then reads every round of the task from the transcripts
// the index names. Never blocks, never speaks to Claude.
'use strict';
const path = require('path');

module.exports = {
  id: 'estimate-marks',
  run(ev, ctx) {
    if (!ctx.project) return null;
    const marks = require(path.join(__dirname, '..', '..', 'skills', 'estimate', 'scripts', 'marks.cjs'));
    const found = [
      ...(ev.transcript_path ? marks.fromRecords(marks.tailRecords(ev.transcript_path)) : []),
      ...marks.found(ev.last_assistant_message, ''),
    ];
    if (!found.length) return null;
    marks.record(path.join(ctx.project.dir, 'memory', 'est-marks.jsonl'), found,
      { session_id: ev.session_id || null, transcript_path: ev.transcript_path || null, cwd: ev.cwd || null });
    return null;
  },
};
