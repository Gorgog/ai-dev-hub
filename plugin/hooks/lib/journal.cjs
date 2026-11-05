// Journal of the hook spine: broken modules (with the policy applied), modules writing to stdout, the health line
// of every session start — one JSON line each, with the hub version. HUB_LOG_DIR, else the plugin's data folder
// (CLAUDE_PLUGIN_DATA), else a temp folder. Writing it never breaks a hook.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// The data folder of the hooks — also of the delivery's session states and events (slice 12).
const dir = () => process.env.HUB_LOG_DIR || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'hub-hooks');
const file = () => path.join(dir(), 'hooks.jsonl');

function journal(entry) {
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* never break the hook */ }
}

module.exports = { journal, file, dir };
