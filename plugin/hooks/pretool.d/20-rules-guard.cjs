// rules-guard (../rules-guard.cjs): rules from memory at the moment of the tool call — base-rules.json plus the
// project's rules.json; log is a reminder through the delivery, ask and deny are decisions with the reason; deny-once
// is a deny with `once` — the key of its rules — that the spine drops after its first time in the epoch (without the
// delivery it becomes the rule's text and the call passes).
'use strict';
const path = require('path');
const { loadRules, evaluate, toHookOutput, journal } = require('../rules-guard.cjs');

module.exports = {
  id: 'rules-guard',
  run(ev, ctx) {
    const proj = ctx.project;
    const { rules, warnings } = loadRules(path.join(__dirname, '..', 'base-rules.json'), proj && proj.dir);
    const result = evaluate(ev, rules);
    journal(proj && proj.dir, ev, result, ctx.version);
    const out = toHookOutput(result, warnings);
    if (!out) return null;
    const o = out.hookSpecificOutput;
    if (result.decision === 'deny-once') {
      const ids = result.hits.filter((h) => h.mode === 'deny-once').map((h) => h.id).sort();
      return { decision: 'deny', reason: o.permissionDecisionReason, once: `rules-guard:${ids.join(',')}` };
    }
    if (o.permissionDecision) return { decision: o.permissionDecision, reason: o.permissionDecisionReason };
    return { items: [{ text: o.additionalContext, priority: 'reminder', key: 'rules-guard' }] };
  },
};
