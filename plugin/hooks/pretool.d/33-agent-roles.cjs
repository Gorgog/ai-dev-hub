// agent-roles (../protect.cjs): tester writes only tests, reviewer and explorer write nothing, agents keep no memory in the repo.
// A deny with the reason; a broken module fails closed inside the hub's projects.
'use strict';
const { agentRoles } = require('../protect.cjs');

module.exports = { id: 'agent-roles', run: (ev, ctx) => agentRoles(ev, ctx) };
