// End of a session (slice 12): every open «prevented» window of its agents closes — one that saw its calls is
// prevented, a shorter one expired; without this the outcomes of the last windows (and of most subagents' ones: they
// mostly read, and reads are not seen) would be lost. Handler «delivery»: only while the delivery is on.
'use strict';
const { end } = require('../lib/deliver.cjs');

module.exports = {
  id: 'delivery-end',
  run(ev, ctx) { if (ctx.delivery) end(ev); return null; },
};
