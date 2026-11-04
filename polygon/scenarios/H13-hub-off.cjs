// Контракт хребта хуков (срез 08): выключатель хаба. При HUB_OFF=1 ни один модуль не срабатывает: плохой доклад не
// блокируется, пуш не спрашивается, бриф SessionStart пуст. Контроль — тот же доклад без выключателя блокируется.
// Файл-флаг в корне хаба — 08 добавляет сюда проверкой, когда назовёт файл.
'use strict';
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent, preToolVerdict, stopVerdict } = require('../lib/hooks.cjs');

const SRC = 'plan.md: выключатель HUB_OFF=1 (08); acceptance §1 «HUB_OFF=1»';

module.exports = {
  id: 'H13', level: 'hook', mech: 'spine', contract: true, title: 'HUB_OFF=1: хаб молчит (контракт 08)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    gitRepo(repo, { 'a.txt': '1\n' });
    const env = (off) => ({ AI_DEV_HUB: hub, ...(off ? { HUB_OFF: '1' } : {}) });
    const stop = (off) => stopVerdict(runEvent(pluginDir, 'Stop', { hook_event_name: 'Stop', session_id: 'eval', cwd: repo,
      last_assistant_message: 'Готово к пушу: DEMO-1, всё проверено.', stop_hook_active: false }, env(off)));
    const push = preToolVerdict(runEvent(pluginDir, 'PreToolUse', { hook_event_name: 'PreToolUse', session_id: 'eval', cwd: repo,
      tool_name: 'Bash', tool_input: { command: 'git push origin DEMO-1' } }, env(true)));
    const brief = runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'eval', cwd: repo }, env(true))
      .map((r) => (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : r.stdout)).join('').trim();
    const off = stop(true), on = stop(false);
    return [
      { id: 'off-stop-silent', kind: 'quiet', source: SRC, pass: !off.block, detail: `при HUB_OFF блок: ${off.reason.slice(0, 100)}` },
      { id: 'off-pretool-silent', kind: 'quiet', source: SRC, pass: push.verdict === 'allow', detail: `при HUB_OFF ${push.verdict}` },
      { id: 'off-brief-empty', kind: 'quiet', source: SRC, pass: brief === '', detail: `при HUB_OFF бриф ${brief.length} знаков` },
      { id: 'on-stop-blocks', source: SRC, pass: on.block, detail: 'без HUB_OFF доклад без sha не блокируется' },
    ];
  },
};
