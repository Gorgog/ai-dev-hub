// protect-files (../protect.cjs): editing an existing .env, a lockfile, a migration already in HEAD.
// A deny with the reason; a broken module fails closed inside the hub's projects.
'use strict';
const { protectFiles } = require('../protect.cjs');

module.exports = { id: 'protect-files', run: (ev, ctx) => protectFiles(ev, ctx) };
