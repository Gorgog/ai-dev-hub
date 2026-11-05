// Журнал событий подачи (срез 12): каждая подача — строка помесячного jsonl со всем адресом вызова (сессия, агент,
// tool_use_id, эпоха, модель, режим); 7 процессов хука одновременно не рвут и не теряют строк (P15); повтор того же
// правила в следующих вызовах эпохи — событие repeat (мера «предотвратил»).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'plan.md: «Подача (срез 12)» — журнал событий с адресом вызова и меткой модели; P15 — дозапись O_APPEND';
const ADDRESS = ['at', 'kind', 'session_id', 'agent_id', 'tool_use_id', 'epoch', 'model', 'mode'];

function readEvents(dir) {
  const d = path.join(dir, 'events');
  let lines = [];
  try { lines = fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean)); } catch { /* none */ }
  const ok = [];
  let torn = 0;
  for (const l of lines) { try { ok.push(JSON.parse(l)); } catch { torn++; } }
  return { ok, torn };
}

// PreToolUse of the hooks under test as Claude Code runs it, without waiting: the command from hooks.json.
function preAsync(pluginDir, ev, env) {
  const h = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0];
  const sub = (s) => String(s).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginDir);
  return new Promise((resolve) => {
    const c = spawn(sub(h.command), (h.args || []).map(sub), { env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginDir, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', (code) => resolve(code));
    c.on('error', () => resolve(-1));
    c.stdin.end(JSON.stringify(ev));
  });
}

module.exports = {
  id: 'H15', level: 'hook', mech: 'delivery', title: 'Журнал подачи: адрес вызова в каждой строке, 7 процессов без рваных строк (12)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['delivery'] }));
    const data = path.join(work, 'data-h15');
    const env = { AI_DEV_HUB: hub, HUB_LOG_DIR: data };
    const ev = (event, extra) => runEvent(pluginDir, event, { hook_event_name: event, session_id: 'eval-h15', permission_mode: 'plan', cwd: repo, ...extra }, env);
    ev('SessionStart', { source: 'startup', model: 'polygon-model' });
    ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'cd /tmp && ls' } });
    ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'u2', tool_input: { command: 'cd /tmp && ls' } });
    const one = readEvents(data).ok;
    const shown = one.filter((e) => e.kind === 'shown' && e.tool_use_id === 'u1');
    const full = one.filter((e) => ADDRESS.some((k) => !(k in e)) || !(e.lesson || e.rule));

    // 7 sessions at once, 10 calls each, every call a new rule text: 70 deliveries.
    const data7 = path.join(work, 'data-h15-par');
    const env7 = { AI_DEV_HUB: hub, HUB_LOG_DIR: data7 };
    const codes = await Promise.all(Array.from({ length: 7 }, async (_, p) => {
      const out = [];
      for (let i = 0; i < 10; i++) {
        out.push(await preAsync(pluginDir, { hook_event_name: 'PreToolUse', session_id: `eval-h15-p${p}`, cwd: repo, tool_name: 'Bash',
          tool_use_id: `v${i}`, tool_input: { command: i % 2 ? `cd /tmp/d${i} && ls` : `git -C /tmp add -A # ${i}` } }, env7));
      }
      return out;
    }));
    const par = readEvents(data7);
    const parShown = par.ok.filter((e) => e.kind === 'shown').length;
    return [
      { id: 'shown-has-address', source: SRC, pass: shown.length === 1 && shown[0].model === 'polygon-model' && shown[0].mode === 'plan' && shown[0].epoch === 1,
        detail: `строка подачи u1: ${JSON.stringify(shown[0] || null).slice(0, 160)}` },
      { id: 'every-line-full', source: SRC, pass: one.length > 0 && full.length === 0, detail: `строк ${one.length}, без поля адреса ${full.length}` },
      { id: 'repeat-event', source: SRC, pass: one.some((e) => e.kind === 'repeat' && e.tool_use_id === 'u2'), detail: `виды: ${[...new Set(one.map((e) => e.kind))].join(', ')}` },
      { id: 'parallel-7-whole', source: SRC, pass: codes.flat().every((c) => c === 0) && par.torn === 0 && parShown >= 7 * 2,
        detail: `коды ≠ 0: ${codes.flat().filter((c) => c !== 0).length}, рваных ${par.torn}, подач ${parShown}` },
    ];
  },
};
