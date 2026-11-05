// Подача fail-open (срез 12): битый файл состояния сессии или недоступный каталог данных не теряют ни текста, ни
// решения — напоминание доходит, запрос на пуш остаётся запросом, хук выходит с 0. Контроль — на исправном каталоге
// повтор того же напоминания подавлен (значит, подача работает, а не выключена).
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent, preToolVerdict } = require('../lib/hooks.cjs');

const SRC = 'plan.md: политика отказа — подача fail-open; acceptance §1 «модуль сломан»';

module.exports = {
  id: 'H16', level: 'hook', mech: 'delivery', title: 'Подача fail-open: битое состояние и недоступный каталог данных (12)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['delivery'] }));
    const data = path.join(work, 'data-h16');
    const pre = (id, command, env) => runEvent(pluginDir, 'PreToolUse', { hook_event_name: 'PreToolUse', session_id: 'eval-h16', cwd: repo,
      tool_name: 'Bash', tool_use_id: id, tool_input: { command } }, { AI_DEV_HUB: hub, HUB_LOG_DIR: data, ...env });
    const ctx = (res) => res.map((r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '').join('');

    runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', session_id: 'eval-h16', source: 'startup', cwd: repo }, { AI_DEV_HUB: hub, HUB_LOG_DIR: data });
    const first = ctx(pre('t1', 'cd /tmp && ls'));
    const again = ctx(pre('t2', 'cd /tmp && ls'));
    const states = path.join(data, 'sessions');
    let broken = 0;
    try { for (const f of fs.readdirSync(states)) { fs.writeFileSync(path.join(states, f), '\0\0{"agents":'); broken++; } } catch { /* no state: the check below says so */ }
    const corrupt = pre('t3', 'cd /tmp && ls');
    const blocked = path.join(work, 'data-h16-file');
    fs.writeFileSync(blocked, '');
    const noDir = pre('t4', 'cd /tmp && ls', { HUB_LOG_DIR: blocked });
    const ask = preToolVerdict(pre('t5', 'git push origin DEMO-1', { HUB_LOG_DIR: blocked }));
    const has = (s) => /cd-no-subshell/.test(s);
    return [
      { id: 'control-dedupe-works', source: 'контроль: исправная подача подавляет повтор', pass: has(first) && !has(again) && broken > 0,
        detail: `первое ${has(first)}, повтор ${has(again)}, файлов состояния ${broken}` },
      { id: 'corrupt-state-delivers', kind: 'quiet', source: SRC, pass: corrupt.every((r) => r.code === 0) && has(ctx(corrupt)),
        detail: `коды ${corrupt.map((r) => r.code).join(',')}, напоминание ${has(ctx(corrupt))}` },
      { id: 'no-data-dir-delivers', kind: 'quiet', source: SRC, pass: noDir.every((r) => r.code === 0) && has(ctx(noDir)),
        detail: `коды ${noDir.map((r) => r.code).join(',')}, напоминание ${has(ctx(noDir))}` },
      { id: 'no-data-dir-decision-stands', source: SRC, pass: ask.verdict === 'ask', detail: `пуш без каталога данных: ${ask.verdict}` },
    ];
  },
};
