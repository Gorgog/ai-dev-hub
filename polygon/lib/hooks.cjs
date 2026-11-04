// Hooks of the version under test as a black box: hooks.json → command, event JSON on stdin — the same contract
// Claude Code uses. No require() of hook internals, so the scenarios survive any rewrite of the hooks.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function loadHooks(pluginDir) {
  const f = path.join(pluginDir, 'hooks', 'hooks.json');
  if (!fs.existsSync(f)) return {};
  return JSON.parse(fs.readFileSync(f, 'utf8')).hooks || {};
}

// What the event's matcher is tested against: the tool for tool events, the source for SessionStart.
const subject = (event, ev) => (/ToolUse/.test(event) ? ev.tool_name : ev.source || '');

function runEvent(pluginDir, event, ev, env = {}) {
  const groups = loadHooks(pluginDir)[event] || [];
  const out = [];
  for (const g of groups) {
    if (g.matcher && !new RegExp(`^(?:${g.matcher})$`).test(subject(event, ev) || '')) continue;
    for (const h of g.hooks || []) {
      if (h.type !== 'command') continue;
      const sub = (s) => String(s).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginDir);
      const fullEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginDir, ...env };
      const r = h.args
        ? spawnSync(sub(h.command), h.args.map(sub), { input: JSON.stringify(ev), env: fullEnv, encoding: 'utf8', timeout: (h.timeout || 30) * 1000 })
        : spawnSync('sh', ['-c', sub(h.command)], { input: JSON.stringify(ev), env: fullEnv, encoding: 'utf8', timeout: (h.timeout || 30) * 1000 });
      let json = null;
      try { json = r.stdout && r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null; } catch { /* plain text */ }
      out.push({ code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json });
    }
  }
  return out;
}

// PreToolUse verdict over all hooks: deny > ask > log (allowed with a reminder) > allow.
function preToolVerdict(results) {
  const rank = { allow: 0, log: 1, ask: 2, deny: 3 };
  let v = 'allow';
  const reasons = [];
  for (const r of results) {
    const o = (r.json && r.json.hookSpecificOutput) || {};
    let cur = 'allow';
    if (r.code === 2) { cur = 'deny'; reasons.push(r.stderr.trim()); }
    else if (o.permissionDecision === 'deny' || (r.json && r.json.decision === 'block')) { cur = 'deny'; reasons.push(o.permissionDecisionReason || r.json.reason || ''); }
    else if (o.permissionDecision === 'ask') { cur = 'ask'; reasons.push(o.permissionDecisionReason || ''); }
    else if (o.additionalContext && /Напоминание|напомин/i.test(o.additionalContext)) { cur = 'log'; reasons.push(o.additionalContext); }
    if (rank[cur] > rank[v]) v = cur;
  }
  return { verdict: v, reasons };
}

// Stop verdict: block when any hook blocks (decision block / exit 2).
function stopVerdict(results) {
  for (const r of results) {
    if (r.code === 2) return { block: true, reason: r.stderr.trim() };
    if (r.json && r.json.decision === 'block') return { block: true, reason: r.json.reason || '' };
  }
  return { block: false, reason: '' };
}

module.exports = { runEvent, preToolVerdict, stopVerdict };
