#!/usr/bin/env node
// PreToolUse hook: the dispatcher's resource lock, enforced.
// Acts ONLY when the session's cwd is inside <hub>/projects/<project>/worktrees/<worktree>/ and the project has
// <hub>/projects/<project>/dispatch-rules.json. Then a tool call that matches a "heavy" or "medium" rule is
// blocked (exit 2, reason on stderr -> shown to Claude) unless <project>/memory/dispatch-grants.json grants that
// kind to this worktree (written by grant.cjs on the dispatcher's side) and the grant has not expired.
// A heavy grant also covers medium. Every rule hit is journaled to <project>/memory/dispatch-guard.log
// (one JSON line: time, worktree, granted/blocked, rule, command). Anything else, or any internal error, is allowed (fail-open):
// the hook must never break sessions outside the dispatcher's scope.
// The plugin's hooks/pretool.cjs calls decide() in the same process; run as a script it is the old standalone hook.
'use strict';
const fs = require('fs');
const path = require('path');

function locate(cwd) {
  const norm = String(cwd || '').replace(/\\/g, '/');
  const m = norm.match(/^(.*\/projects\/[^/]+)\/worktrees\/([^/]+)(?:\/|$)/i);
  if (!m) return null;
  return { projectDir: m[1], holder: m[2] };
}

function matches(rule, toolName, toolInput) {
  if (rule.tools && !new RegExp(rule.tools, 'i').test(toolName)) return false;
  if (rule.commands) {
    const cmd = toolInput && typeof toolInput.command === 'string' ? toolInput.command : null;
    if (cmd === null || !new RegExp(rule.commands, 'i').test(cmd)) return false;
  }
  if (rule.input && !new RegExp(rule.input, 'i').test(JSON.stringify(toolInput || {}))) return false;
  return Boolean(rule.tools || rule.commands || rule.input);
}

// null — allow; { reason } — block.
function decide(ev) {
  const where = locate(ev.cwd);
  if (!where) return null;

  const rulesPath = path.join(where.projectDir, 'dispatch-rules.json');
  if (!fs.existsSync(rulesPath)) return null;
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

  let kind = null, hit = null;
  for (const k of ['heavy', 'medium']) {
    for (const r of rules[k] || []) {
      if (matches(r, ev.tool_name || '', ev.tool_input)) { kind = k; hit = r; break; }
    }
    if (kind) break;
  }
  if (!kind) return null;

  let grants = {};
  const grantsPath = path.join(where.projectDir, 'memory', 'dispatch-grants.json');
  try { grants = JSON.parse(fs.readFileSync(grantsPath, 'utf8')); } catch { grants = {}; }
  const now = Date.now();
  const valid = (g) => g && g.holder === where.holder && (!g.until || Date.parse(g.until) > now);
  // Journal of every rule hit (granted or blocked): proves the lock works and shows rules that misfire.
  const log = (decision) => {
    try {
      const what = typeof (ev.tool_input || {}).command === 'string' ? ev.tool_input.command : JSON.stringify(ev.tool_input || {});
      fs.appendFileSync(path.join(where.projectDir, 'memory', 'dispatch-guard.log'),
        JSON.stringify({ at: new Date(now).toISOString(), worktree: where.holder, decision, kind, rule: hit.name,
          tool: ev.tool_name, what: what.slice(0, 200) }) + '\n');
    } catch { /* journal must never break the hook */ }
  };
  if (valid(grants[kind]) || (kind === 'medium' && valid(grants.heavy))) { log('granted'); return null; }
  log('blocked');

  const label = kind === 'heavy' ? 'тяжёлое' : 'среднее';
  const cur = grants[kind];
  const t = (x) => (x ? new Date(x).toLocaleString('ru-RU') : '');
  const busy = cur && cur.holder
    ? (cur.holder === where.holder
        ? `Твоё разрешение истекло (${t(cur.until)}).`
        : `Сейчас держит: ${cur.holder}${cur.what ? ' (' + cur.what + ')' : ''}${cur.until ? ' до ' + t(cur.until) : ''}.`)
    : 'Сейчас никто не держит.';
  return { reason:
    `Заблокировано замком диспетчера: «${hit.name}» — ${label}. ${busy}\n` +
    `Напиши диспетчеру: «Прошу ${hit.name} на ~N мин: <зачем>» и дождись «Разрешаю». Пока делай лёгкое.\n` +
    `(worktree «${where.holder}», правила — ${rulesPath})\n` };
}

if (require.main === module) {
  try {
    let ev = {};
    try { ev = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
    const r = decide(ev);
    if (r) { process.stderr.write(r.reason); process.exit(2); }
  } catch { /* fail-open */ }
  process.exit(0);
}

module.exports = { decide, locate };
