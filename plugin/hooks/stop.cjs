#!/usr/bin/env node
// v1 entry of Stop, kept for sessions started before the spine (their hooks.json calls this file). The done-gate
// itself lives in plugin/lib/done-gate.cjs and runs from stop.d/10-done-gate.cjs (and 11-done-facts.cjs) through
// the spine.
'use strict';
if (require.main === module) require('./run.cjs').cli('Stop');
