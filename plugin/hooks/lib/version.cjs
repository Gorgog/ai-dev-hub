// The version label of the hooks in use: the short sha of the git checkout the plugin runs from (P17: hooks run
// straight from the working tree of the hub's main copy, not from a cache). Read from .git files, no git process:
// it is on the hot path of every journal line. A worktree's .git is a file pointing at its gitdir; refs may be
// loose or packed in the common dir. No git — '?'.
'use strict';
const fs = require('fs');
const path = require('path');

const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };

function gitDir(root) {
  const g = path.join(root, '.git');
  let st; try { st = fs.statSync(g); } catch { return null; }
  if (st.isDirectory()) return g;
  const m = (read(g) || '').match(/^gitdir:\s*(.+)$/m);
  return m ? path.resolve(root, m[1]) : null;
}

function headSha(root) {
  const gd = gitDir(root);
  if (!gd) return null;
  const head = read(path.join(gd, 'HEAD'));
  if (!head) return null;
  const ref = (head.match(/^ref:\s*(\S+)/) || [])[1];
  if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  const common = path.resolve(gd, read(path.join(gd, 'commondir')) || '.');
  for (const d of [gd, common]) { const s = read(path.join(d, ref)); if (s) return s; }
  const packed = read(path.join(common, 'packed-refs')) || '';
  const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
  return line ? line.split(' ')[0] : null;
}

// <plugin>/.. is the checkout: the hub root for the installed plugin, the worktree for --plugin-dir <wt>/plugin.
function version(pluginRoot) {
  const sha = headSha(path.dirname(pluginRoot));
  return sha ? sha.slice(0, 7) : '?';
}

module.exports = { version, headSha };
