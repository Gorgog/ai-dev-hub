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
    ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: "sed -i 's/a/b/' notes.txt" } });
    ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'u2', tool_input: { command: "sed -i 's/a/b/' notes.txt" } });
    const one = readEvents(data).ok;
    const shown = one.filter((e) => e.kind === 'shown' && e.tool_use_id === 'u1');
    const full = one.filter((e) => ADDRESS.some((k) => !(k in e)) || !(e.lesson || e.rule));

    // «Prevented»: a copy of the plugin with a synthetic lesson module whose trigger is its detector (no real module
    // has one before slice 21). Answer known: L1 repeats on the 2nd call after it (repeat in the window), L2 does not
    // repeat in 3 calls (prevented at the start of the 4th), L3's window is closed by the end of the session.
    const copy = path.join(work, 'plugin-h15');
    fs.cpSync(pluginDir, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'hooks', 'pretool.d', '99-polygon-lesson.cjs'), `module.exports = { id: 'polygon-lesson', run(ev) {
      const m = /POLYGON-BAD-(L\\d)/.exec((ev.tool_input || {}).command || '');
      return m ? { items: [{ text: 'урок ' + m[1], priority: 'lesson', key: m[1], lesson: m[1], detector: 'D-' + m[1], source: 'memory' }] } : null;
    } };\n`);
    const dataP = path.join(work, 'data-h15-prevented');
    // L3 at the end: its window sees its 3 calls and the session ends — prevented by SessionEnd, no 4th call needed.
    const seq = ['POLYGON-BAD-L1', 'echo ok', 'POLYGON-BAD-L1', 'POLYGON-BAD-L2', 'echo ok', 'echo ok', 'echo ok', 'echo ok',
      'POLYGON-BAD-L3', 'echo ok', 'echo ok', 'echo ok'];
    seq.forEach((command, i) => runEvent(copy, 'PreToolUse', { hook_event_name: 'PreToolUse', session_id: 'eval-h15-k', cwd: repo,
      tool_name: 'Bash', tool_use_id: `k${i + 1}`, tool_input: { command } }, { AI_DEV_HUB: hub, HUB_LOG_DIR: dataP }));
    runEvent(copy, 'SessionEnd', { hook_event_name: 'SessionEnd', session_id: 'eval-h15-k', cwd: repo, reason: 'exit' }, { AI_DEV_HUB: hub, HUB_LOG_DIR: dataP });
    const outcome = readEvents(dataP).ok.filter((e) => e.kind !== 'shown').map((e) => `${e.kind}:${e.lesson}:${e.tool_use_id}`);

    // 7 sessions at once, 10 calls each, two rules in turn: rules-guard's text does not depend on the command, so each
    // session gets 2 deliveries (14 in all) and 8 suppressed repeats — the check is that 70 processes tear no line.
    const data7 = path.join(work, 'data-h15-par');
    const env7 = { AI_DEV_HUB: hub, HUB_LOG_DIR: data7 };
    const codes = await Promise.all(Array.from({ length: 7 }, async (_, p) => {
      const out = [];
      for (let i = 0; i < 10; i++) {
        out.push(await preAsync(pluginDir, { hook_event_name: 'PreToolUse', session_id: `eval-h15-p${p}`, cwd: repo, tool_name: 'Bash',
          tool_use_id: `v${i}`, tool_input: { command: i % 2 ? `sed -i 's/a/b/' d${i}.txt` : `git -C /tmp add -A # ${i}` } }, env7));
      }
      return out;
    }));
    const par = readEvents(data7);
    const parShown = par.ok.filter((e) => e.kind === 'shown').length;
    return [
      { id: 'shown-has-address', source: SRC, pass: shown.length === 1 && shown[0].model === 'polygon-model' && shown[0].mode === 'plan' && shown[0].epoch === 1,
        detail: `строка подачи u1: ${JSON.stringify(shown[0] || null).slice(0, 160)}` },
      { id: 'every-line-full', source: SRC, pass: one.length > 0 && full.length === 0, detail: `строк ${one.length}, без поля адреса ${full.length}` },
      { id: 'suppressed-not-journaled', kind: 'quiet', source: SRC, pass: one.length > 0 && !one.some((e) => e.kind === 'shown' && e.tool_use_id === 'u2'),
        detail: `строки повтора u2: ${one.filter((e) => e.tool_use_id === 'u2').map((e) => e.kind).join(', ') || 'нет'}` },
      { id: 'prevented-known-answer', source: 'plan.md: мера «предотвратил» — окно ≤ 3 вызовов (P10)', pass: outcome.join(' ') === 'repeat:L1:k3 prevented:L2:k8 prevented:L3:null',
        detail: `исходы: ${outcome.join(' ') || 'нет'}; ждали repeat:L1:k3 prevented:L2:k8 prevented:L3:null` },
      { id: 'parallel-7-whole', source: SRC, pass: codes.flat().every((c) => c === 0) && par.torn === 0 && parShown >= 7 * 2,
        detail: `коды ≠ 0: ${codes.flat().filter((c) => c !== 0).length}, рваных ${par.torn}, подач ${parShown}` },
    ];
  },
};
