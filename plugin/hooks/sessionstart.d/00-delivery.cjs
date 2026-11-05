// Start of an epoch of context (slice 12, P16): SessionStart startup | clear | compact opens a new epoch of the main
// thread — what the delivery showed before is shown again, the open «prevented» windows of the old epoch close;
// resume keeps the epoch. The stage of this record is the stage of the whole delivery (lib/deliver.cjs): off — the
// delivery of 08. At startup old state files are swept. First in the folder: the modules after it see the new epoch;
// if it fails, the delivery opens the epoch itself.
'use strict';
const { begin } = require('../lib/deliver.cjs');

module.exports = {
  id: 'delivery',
  run(ev, ctx) { if (ctx.delivery) begin('SessionStart', ev); return null; },
};
