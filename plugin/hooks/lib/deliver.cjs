// The one point where text reaches Claude's context. A stub for slice 12 (limits per call and per epoch, «already
// shown» keys): for now — order by priority (block > lesson > reminder > info), one item per key, joined by lines.
'use strict';

const PRIORITY = { block: 0, lesson: 1, reminder: 2, info: 3 };
const rank = (p) => (p in PRIORITY ? PRIORITY[p] : PRIORITY.info);

function deliver(items) {
  const seen = new Set();
  return items
    .map((it, i) => ({ ...it, i }))
    .sort((a, b) => rank(a.priority) - rank(b.priority) || a.i - b.i)
    .filter((it) => (it.key == null ? true : !seen.has(it.key) && seen.add(it.key)))
    .map((it) => it.text)
    .filter(Boolean)
    .join('\n');
}

module.exports = { deliver, PRIORITY };
