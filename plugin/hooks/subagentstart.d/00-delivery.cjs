// Start of a subagent's epoch (slice 12, P16): a subagent has its own context, so its own epoch under its agent_id —
// the delivery shows it what the main thread has seen already; a continued subagent keeps its epoch. Handler
// «delivery»: runs only while the delivery is on (ctx.delivery — the stage of the record «delivery»).
'use strict';
const { begin } = require('../lib/deliver.cjs');

module.exports = {
  id: 'delivery-subagent',
  run(ev, ctx) { if (ctx.delivery) begin('SubagentStart', ev); return null; },
};
