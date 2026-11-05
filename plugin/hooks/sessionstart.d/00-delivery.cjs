// Start of an epoch of context (slice 12, P16): SessionStart startup | clear | compact opens a new epoch of the main
// thread — what the delivery showed before is shown again, the open «prevented» windows of the old epoch expire;
// resume keeps the epoch. The stage of this record is the stage of the whole delivery (lib/deliver.cjs): off — the
// delivery of 08. At startup old state files are swept. First in the folder: the modules after it see the new epoch.
'use strict';
const { begin } = require('../lib/deliver.cjs');

module.exports = {
  id: 'delivery',
  run(ev) { begin('SessionStart', ev); return null; },
};
