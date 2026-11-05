// State file of a session (slice 12) — skeleton: the tests come first.
'use strict';
const path = require('path');

const freshAgent = (epoch) => ({ epoch });
const file = (sid, dir) => path.join(dir, String(sid));
const read = () => ({ agents: {} });
const update = () => null;
const startEpoch = () => ({ expired: [] });
const sweep = () => {};

module.exports = { freshAgent, file, read, update, startEpoch, sweep };
