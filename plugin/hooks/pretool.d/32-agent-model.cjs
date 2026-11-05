// agent-model (../protect.cjs): hub:reviewer launched on a model other than Opus.
// A deny with the reason; a broken module fails closed inside the hub's projects.
'use strict';
const { agentModel } = require('../protect.cjs');

module.exports = { id: 'agent-model', run: (ev, ctx) => agentModel(ev, ctx) };
