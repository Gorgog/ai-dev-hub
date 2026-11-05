// node:sqlite for the memory library (index — store.cjs, the event lock — events.cjs): DatabaseSync or null. Null when
// HUB_MEMORY_ENGINE=js or the node has none. node 22 warns «SQLite is an experimental feature» on stderr — a hook's
// stderr must stay clean (P2), so the warning is swallowed while the module loads.
'use strict';
let cache;
module.exports = function sqlite() {
  if (cache !== undefined) return cache;
  if (process.env.HUB_MEMORY_ENGINE === 'js') return (cache = null);
  const orig = process.emitWarning;
  process.emitWarning = function (w, ...a) {
    const type = typeof a[0] === 'string' ? a[0] : a[0] && a[0].type;
    if (type === 'ExperimentalWarning' || (w && w.name === 'ExperimentalWarning')) return undefined;
    return orig.call(process, w, ...a);
  };
  try { cache = require('node:sqlite').DatabaseSync; } catch { cache = null; } finally { process.emitWarning = orig; }
  return cache;
};
