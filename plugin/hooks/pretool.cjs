#!/usr/bin/env node
// v1 entry of PreToolUse, kept for sessions started before the spine: their hooks.json (read once at session start)
// still calls this file. Same behaviour as `node run.cjs PreToolUse`. Remove once no such session can be alive.
'use strict';
require('./run.cjs').cli('PreToolUse');
