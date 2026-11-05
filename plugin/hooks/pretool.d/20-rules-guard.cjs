// rules-guard (../rules-guard.cjs): rules from memory at the moment of the tool call — base-rules.json plus the
// project's rules.json; log is a reminder through the delivery, ask and deny are decisions with the reason; deny-once
// is a deny with `once` — the key of ONE rule, the first deny-once by id (a key of a set would be new for every new set,
// and a rule would deny again) — that the spine drops after its first time in the epoch (without the delivery it becomes
// the rule's text and the call passes). The other rules of the call ride along as a reminder item: a dropped deny keeps it.
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
      const key = result.hits.filter((h) => h.mode === 'deny-once').map((h) => h.id).sort()[0];
      const rest = toHookOutput({ decision: 'log', hits: result.hits.filter((h) => h.id !== key) }, warnings);
      const items = rest && rest.hookSpecificOutput.additionalContext
        ? [{ text: rest.hookSpecificOutput.additionalContext, priority: 'reminder', key: 'rules-guard' }] : undefined;
      return { decision: 'deny', reason: o.permissionDecisionReason, once: `rules-guard:${key}`, items };
    }
    if (o.permissionDecision) return { decision: o.permissionDecision, reason: o.permissionDecisionReason };
    return { items: [{ text: o.additionalContext, priority: 'reminder', key: 'rules-guard' }] };
  },
};
