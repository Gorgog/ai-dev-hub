// inline-script (../protect.cjs): a script with escaping in node -e / python -c / heredoc, deny with the ready command.
// A deny with the reason; a broken module fails closed inside the hub's projects.
'use strict';
const { inlineScript } = require('../protect.cjs');

module.exports = { id: 'inline-script', run: (ev, ctx) => inlineScript(ev, ctx) };
