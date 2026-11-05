// Protection of slice 13 — stub for the red test; the mechanisms come next.
'use strict';
const os = require('os');
const path = require('path');

const SCRIPTS_DIR = path.join(os.tmpdir(), 'hub-scripts');
const none = () => null;

module.exports = { SCRIPTS_DIR, protectFiles: none, inlineScript: none, agentModel: none, agentRoles: none };
