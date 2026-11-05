// Where the hub is and whether a cwd belongs to one of its projects. Shared by the spine and the modules.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// The hub (where projects/ live): AI_DEV_HUB, else the folder of the `hub` marketplace in user settings (the plugin
// may run from a cache copy), else two levels above the plugin (<hub>/plugin/hooks).
function hubRoot() {
  if (process.env.AI_DEV_HUB) return process.env.AI_DEV_HUB;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const m = s.extraKnownMarketplaces && s.extraKnownMarketplaces.hub;
    const p = m && m.source && m.source.path;
    if (p && fs.existsSync(path.join(p, 'projects'))) return p;
  } catch { /* fall through */ }
  return path.resolve(__dirname, '..', '..', '..');
}
const HUB_ROOT = hubRoot();
const trim = (p) => String(p || '').replace(/\/+$/, '');
// A path through a symlink is compared by its target; a path that does not exist — as given.
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

// projects/<name> of THIS hub only: the plugin runs in every session of the user, and a folder named
// «projects» elsewhere is not ours. Both sides go through realpath: a hub reached through a symlink (~/hub ->
// /data/ai-dev-hub) would otherwise never match the session's resolved cwd and switch the hooks off silently.
// Case matters on Linux: /Hub is not /hub.
function findProject(cwd, hub = HUB_ROOT) {
  const c = trim(real(cwd)), h = trim(real(hub));
  if (!c.startsWith(`${h}/projects/`)) return null;
  const name = c.slice(h.length + '/projects/'.length).split('/')[0];
  return name ? { dir: `${h}/projects/${name}`, name } : null;
}

// worktrees/<name> of the project, or null.
function worktreeOf(cwd, proj) {
  if (!proj) return null;
  const rel = trim(real(cwd)).slice(proj.dir.length).replace(/^\/+/, '').split('/');
  return rel[0] === 'worktrees' && rel[1] ? rel[1] : null;
}

// The switch: HUB_OFF=1, or the flag file .hub-off in the hub root or beside the plugin (a --plugin-dir copy).
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const flagFiles = () => [...new Set([path.join(HUB_ROOT, '.hub-off'), path.join(path.dirname(PLUGIN_ROOT), '.hub-off')])];
const isOff = () => process.env.HUB_OFF === '1' || flagFiles().some((f) => fs.existsSync(f));

module.exports = { hubRoot, HUB_ROOT, PLUGIN_ROOT, findProject, worktreeOf, real, flagFiles, isOff };
