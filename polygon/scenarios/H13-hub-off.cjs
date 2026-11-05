// Контракт хребта хуков (срез 08): выключатель хаба. При HUB_OFF=1 и при файле-флаге <хаб>/.hub-off ни один модуль
// не срабатывает: плохой доклад не блокируется, пуш не спрашивается, бриф SessionStart пуст. Контроль — тот же доклад
// без выключателя блокируется.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent, preToolVerdict, stopVerdict } = require('../lib/hooks.cjs');

const SRC = 'plan.md: выключатель HUB_OFF=1 и файл-флаг (08); acceptance §1 «HUB_OFF=1»';

module.exports = {
  id: 'H13', level: 'hook', mech: 'spine', contract: true, title: 'Выключатель HUB_OFF=1 и .hub-off: хаб молчит (контракт 08)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    gitRepo(repo, { 'a.txt': '1\n' });
    const env = (off) => ({ AI_DEV_HUB: hub, ...(off ? { HUB_OFF: '1' } : {}) });
    const stop = (off) => stopVerdict(runEvent(pluginDir, 'Stop', { hook_event_name: 'Stop', session_id: 'eval', cwd: repo,
      last_assistant_message: 'Готово к пушу: DEMO-1, всё проверено.', stop_hook_active: false }, env(off)));
    const push = (off) => preToolVerdict(runEvent(pluginDir, 'PreToolUse', { hook_event_name: 'PreToolUse', session_id: 'eval', cwd: repo,
      tool_name: 'Bash', tool_input: { command: 'git push origin DEMO-1' } }, env(off)));
    const brief = (off) => runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'eval', cwd: repo }, env(off))
      .map((r) => (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : r.stdout)).join('').trim();
    const off = stop(true), offPush = push(true), offBrief = brief(true);
    // The flag file in the hub root, without HUB_OFF: what a live session sees (its environment cannot change).
    const flag = path.join(hub, '.hub-off');
    fs.writeFileSync(flag, '');
    const fStop = stop(false), fPush = push(false), fBrief = brief(false);
    fs.rmSync(flag);
    const on = stop(false);
    return [
      { id: 'off-stop-silent', kind: 'quiet', source: SRC, pass: !off.block, detail: `при HUB_OFF блок: ${off.reason.slice(0, 100)}` },
      { id: 'off-pretool-silent', kind: 'quiet', source: SRC, pass: offPush.verdict === 'allow', detail: `при HUB_OFF ${offPush.verdict}` },
      { id: 'off-brief-empty', kind: 'quiet', source: SRC, pass: offBrief === '', detail: `при HUB_OFF бриф ${offBrief.length} знаков` },
      { id: 'flag-stop-silent', kind: 'quiet', source: SRC, pass: !fStop.block, detail: `при .hub-off блок: ${fStop.reason.slice(0, 100)}` },
      { id: 'flag-pretool-silent', kind: 'quiet', source: SRC, pass: fPush.verdict === 'allow', detail: `при .hub-off ${fPush.verdict}` },
      { id: 'flag-brief-empty', kind: 'quiet', source: SRC, pass: fBrief === '', detail: `при .hub-off бриф ${fBrief.length} знаков` },
      { id: 'on-stop-blocks', source: SRC, pass: on.block, detail: 'без выключателя доклад без sha не блокируется' },
    ];
  },
};
