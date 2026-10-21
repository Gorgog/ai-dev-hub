// rules-guard: rules from memory, enforced at the moment of the tool call.
// Rules — hooks/base-rules.json (any project) + projects/<name>/rules.json of the hub ({rules, modes}).
// Mode per rule: log (default for every new rule: pass, remind Claude, journal), ask (permission prompt),
// deny (block with the reason). A project raises or lowers a rule with "modes": {"<id>": "deny"}.
'use strict';
const fs = require('fs');
const path = require('path');

const RANK = { log: 1, ask: 2, deny: 3 };
const FIELDS = ['tools', 'commands', 'input', 'path'];
const HUB_ROOT = path.resolve(__dirname, '..');
const slash = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

// projects/<name> of THIS hub only: the plugin runs in every session of the user, and a folder named
// «projects» elsewhere is not ours. A junction to the hub (old drive letter) resolves through realpath.
function findProject(cwd, hub = HUB_ROOT) {
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch { /* a path that does not exist is compared as given */ }
  const c = slash(real), h = slash(hub);
  if (!c.toLowerCase().startsWith(`${h.toLowerCase()}/projects/`)) return null;
  const name = c.slice(h.length + '/projects/'.length).split('/')[0];
  return name ? { dir: `${h}/projects/${name}`, name } : null;
}

function readJson(file, warnings) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    warnings.push(`${path.basename(file)} не читается (${String(e.message).split('\n')[0]}) — его правила не действуют`);
    return null;
  }
}

// Every defect of the rules is a warning in Claude's context, never a silently dropped rule.
function loadRules(baseFile, projectDir) {
  const warnings = [];
  const base = readJson(baseFile, warnings) || [];
  const proj = projectDir ? readJson(path.join(projectDir, 'rules.json'), warnings) || {} : {};
  const projRules = Array.isArray(proj) ? proj : proj.rules || [];
  const modes = Array.isArray(proj) ? {} : proj.modes || {};
  const rules = [];
  for (const r of [...(Array.isArray(base) ? base : []), ...projRules]) {
    let mode = modes[r.id] || r.mode || 'log';
    if (!RANK[mode]) { warnings.push(`правило ${r.id}: режим «${mode}» неизвестен — действует как log`); mode = 'log'; }
    const bad = FIELDS.find((f) => { if (!r[f]) return false; try { new RegExp(r[f], 'i'); return false; } catch { return true; } });
    if (bad) { warnings.push(`правило ${r.id}: битый регэксп в «${bad}» — правило не действует`); continue; }
    rules.push({ ...r, mode });
  }
  return { rules, warnings };
}

function matches(rule, ev) {
  const input = ev.tool_input || {};
  const file = input.file_path || input.notebook_path || input.path;
  if (rule.tools && !new RegExp(rule.tools, 'i').test(ev.tool_name || '')) return false;
  if (rule.commands && !(typeof input.command === 'string' && new RegExp(rule.commands, 'i').test(input.command))) return false;
  if (rule.input && !new RegExp(rule.input, 'i').test(JSON.stringify(input))) return false;
  if (rule.path && !(typeof file === 'string' && new RegExp(rule.path, 'i').test(file.replace(/\\/g, '/')))) return false;
  return FIELDS.some((f) => rule[f]);
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

module.exports = { findProject, loadRules, evaluate, toHookOutput, journal, HUB_ROOT };
