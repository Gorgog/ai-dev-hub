// rules-guard: rules from memory, enforced at the moment of the tool call.
// Rules — hooks/base-rules.json (any project) + projects/<name>/rules.json of the hub ({rules, modes}).
// Mode per rule: log (default for every new rule: pass, remind Claude, journal), ask (permission prompt),
// deny (block with the reason). A project raises or lowers a rule with "modes": {"<id>": "deny"}.
'use strict';
const fs = require('fs');
const path = require('path');

const RANK = { log: 1, ask: 2, deny: 3 };

function findProject(cwd) {
  const norm = String(cwd || '').replace(/\\/g, '/');
  const m = norm.match(/^(.*\/projects\/([^/]+))(?:\/|$)/i);
  return m ? { dir: m[1], name: m[2] } : null;
}

function readJson(file, warnings) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    warnings.push(`${path.basename(file)} не читается (${String(e.message).split('\n')[0]}) — его правила не действуют`);
    return null;
  }
}

function loadRules(baseFile, projectDir) {
  const warnings = [];
  const base = readJson(baseFile, warnings) || [];
  const proj = projectDir ? readJson(path.join(projectDir, 'rules.json'), warnings) || {} : {};
  const modes = proj.modes || {};
  const rules = [...base, ...(proj.rules || [])].map((r) => ({ ...r, mode: modes[r.id] || r.mode || 'log' }));
  return { rules, warnings };
}

function matches(rule, ev) {
  const input = ev.tool_input || {};
  if (rule.tools && !new RegExp(rule.tools, 'i').test(ev.tool_name || '')) return false;
  if (rule.commands && !(typeof input.command === 'string' && new RegExp(rule.commands, 'i').test(input.command))) return false;
  if (rule.input && !new RegExp(rule.input, 'i').test(JSON.stringify(input))) return false;
  return Boolean(rule.tools || rule.commands || rule.input);
}

function evaluate(ev, rules) {
  const hits = rules.filter((r) => { try { return matches(r, ev); } catch { return false; } })
    .map((r) => ({ id: r.id, mode: r.mode || 'log', text: r.text }));
  const decision = hits.reduce((d, h) => (!d || RANK[h.mode] > RANK[d] ? h.mode : d), null);
  return { decision, hits };
}

function toHookOutput(result, warnings) {
  const lines = result.hits.map((h) => `${h.id}: ${h.text}`);
  const note = warnings.length ? `\nrules-guard: ${warnings.join('; ')}` : '';
  if (result.decision === 'deny' || result.decision === 'ask') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision,
      permissionDecisionReason: `Правило из памяти — ${lines.join('; ')}${note}` } };
  }
  if (result.decision === 'log' || warnings.length) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse',
      additionalContext: (lines.length ? `Напоминание правил памяти: ${lines.join('; ')}` : '') + note } };
  }
  return null;
}

function journal(projectDir, ev, result) {
  if (!result.hits.length) return;
  const dir = projectDir ? path.join(projectDir, 'memory') : process.env.CLAUDE_PLUGIN_DATA;
  if (!dir) return;
  try {
    const input = ev.tool_input || {};
    const what = typeof input.command === 'string' ? input.command : input.file_path || JSON.stringify(input);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'rules-guard.log'), result.hits.map((h) => JSON.stringify({
      at: new Date().toISOString(), id: h.id, mode: h.mode, tool: ev.tool_name, what: String(what).slice(0, 200),
      agent: ev.agent_type || undefined,
    })).join('\n') + '\n');
  } catch { /* the journal must never break the hook */ }
}

module.exports = { findProject, loadRules, evaluate, toHookOutput, journal };
