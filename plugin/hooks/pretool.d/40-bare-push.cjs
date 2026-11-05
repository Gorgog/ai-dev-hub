// bare-push (../push.cjs): a bare `git push` inside the hub — deny with the way through push-slice.
// A broken module fails closed inside the hub's projects.
'use strict';
const { barePush } = require('../push.cjs');

module.exports = { id: 'bare-push', run: (ev, ctx) => barePush(ev, ctx) };
