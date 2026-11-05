// rules-guard: rules from memory, enforced at the moment of the tool call.
// Rules — hooks/base-rules.json (any project) + projects/<name>/rules.json of the hub ({rules, modes}).
// Mode per rule: log (default for every new rule: pass, remind Claude, journal), ask (permission prompt),
// deny-once (block with the reason the first time in a context epoch, then pass — the spine keeps the key; the step the
// weekly cycle raises an ineffective reminder to, slice 24), deny (block with the reason). A project raises or lowers a rule with "modes": {"<id>": "deny"}.
'use strict';
const fs = require('fs');
const path = require('path');

// ask stays above deny-once: a permission prompt is the user's gate, a deny-once passes after its first time.
const RANK = { log: 1, 'deny-once': 2, ask: 3, deny: 4 };
const FIELDS = ['tools', 'commands', 'input', 'path'];
// Where the hub is and which project a cwd is in — lib/hub.cjs, shared with the spine.
const { HUB_ROOT, findProject } = require('./lib/hub.cjs');

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
  let proj = projectDir ? readJson(path.join(projectDir, 'rules.json'), warnings) || {} : {};
  // The shape of rules.json: an array of rules, or {rules: [...], modes: {id: mode}} — anything else is reported.
  const shape = (msg) => warnings.push(`rules.json: ${msg} — ожидается {"rules": [...], "modes": {...}} или массив правил`);
  if (proj === null || (typeof proj !== 'object')) { shape(`верхний уровень ${JSON.stringify(proj)}`); proj = {}; }
  if (!Array.isArray(proj)) {
    for (const k of Object.keys(proj)) if (k !== 'rules' && k !== 'modes') shape(`лишний ключ «${k}»`);
    if (proj.rules !== undefined && !Array.isArray(proj.rules)) { shape('«rules» не массив, правила проекта не действуют'); proj = { ...proj, rules: [] }; }
    if (proj.modes !== undefined && (typeof proj.modes !== 'object' || proj.modes === null || Array.isArray(proj.modes))) { shape('«modes» не объект'); proj = { ...proj, modes: {} }; }
  }
  const projRules = Array.isArray(proj) ? proj : proj.rules || [];
  const modes = Array.isArray(proj) ? {} : proj.modes || {};
  const rules = [];
  const all = [...(Array.isArray(base) ? base : []), ...(Array.isArray(projRules) ? projRules : [])];
  const ids = new Set(all.filter((r) => r && typeof r === 'object').map((r) => r.id));
  for (const id of Object.keys(modes)) if (!ids.has(id)) warnings.push(`modes: правила «${id}» нет — режим не действует`);
  for (const r of all) {
    if (!r || typeof r !== 'object') { warnings.push(`${JSON.stringify(r)} в rules.json — не правило, пропущено`); continue; }
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
  if (rule.path && !(typeof file === 'string' && new RegExp(rule.path, 'i').test(file))) return false;
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
  if (result.decision === 'deny' || result.decision === 'ask' || result.decision === 'deny-once') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision === 'ask' ? 'ask' : 'deny',
      permissionDecisionReason: `Правило из памяти — ${lines.join('; ')}${note}` } };
  }
  if (result.decision === 'log' || warnings.length) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse',
      additionalContext: (lines.length ? `Напоминание правил памяти: ${lines.join('; ')}` : '') + note } };
  }
  return null;
}

function journal(projectDir, ev, result, hub) {
  if (!result.hits.length) return;
  const dir = projectDir ? path.join(projectDir, 'memory') : process.env.CLAUDE_PLUGIN_DATA;
  if (!dir) return;
  try {
    const input = ev.tool_input || {};
    const what = typeof input.command === 'string' ? input.command : input.file_path || JSON.stringify(input);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'rules-guard.log'), result.hits.map((h) => JSON.stringify({
      at: new Date().toISOString(), id: h.id, mode: h.mode, tool: ev.tool_name, what: String(what).slice(0, 200),
      agent: ev.agent_type || undefined, hub: hub || undefined,
    })).join('\n') + '\n');
  } catch { /* the journal must never break the hook */ }
}

module.exports = { findProject, loadRules, evaluate, toHookOutput, journal, HUB_ROOT };
