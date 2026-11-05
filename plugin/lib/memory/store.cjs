// Memory storage interface (stub: the red commit of slice 14).
'use strict';
const none = () => null;
const empty = () => ({ engine: 'none', hits: [], problems: [] });
module.exports = {
  find: empty, ensureIndex: () => ({ rebuilt: false }), indexFold: none, fold: () => ({ entries: [], stats: {} }),
  shown: none, repeat: none, addLesson: () => ({ ok: false, problems: [] }), retire: none, merge: none, supersede: none,
  why: () => ({ events: [] }), ensureTriggers: () => ({ rebuilt: false }), readTriggers: () => ({ lessons: [] }),
  check: () => ({ problems: [] }), exportAll: () => ({ files: [] }), importAll: none, exportV1: () => ({}),
  retirementCandidates: () => [], memoryDir: none,
};
