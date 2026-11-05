// done-gate: a report «готово к пушу» judged by facts (slice 16). Skeleton for the red tests.
'use strict';
const isReport = () => null;
const target = () => null;
const basics = () => [];
const facts = () => [];
const lastFullPath = (wt) => require('path').join(wt, '.git-last-full.json');
module.exports = { isReport, target, basics, facts, lastFullPath };
