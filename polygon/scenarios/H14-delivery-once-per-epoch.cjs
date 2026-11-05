// Подача (срез 12): одно и то же — один показ в эпохе агента. Напоминание rules-guard на тот же `cd` повторно не
// подаётся, другое правило — подаётся; resume эпоху не открывает (бриф в контексте уже есть), компакция открывает
// (бриф и напоминание — снова), у субагента — своя эпоха. Контроль — тот же проект вне канарейки подачи: подача 08
// повторяет напоминание на каждом вызове.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'plan.md: «Подача (срез 12)» — ключ «уже показан» = (session_id, agent_id, эпоха); P16 — границы эпох';
const CD = "sed -i 's/a/b/' notes.txt"; // a sed-in-place reminder (cd-no-subshell is gone: the cwd is kept)

// Text the hooks hand to Claude for one event: additionalContext of JSON outputs, plain stdout otherwise.
const said = (res) => res.map((r) => (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : r.json ? '' : r.stdout)).join('');

function session(pluginDir, cwd, env) {
  const ev = (event, extra) => runEvent(pluginDir, event, { hook_event_name: event, session_id: 'eval-h14', permission_mode: 'default', cwd, ...extra }, env);
  return {
    start: (source) => said(ev('SessionStart', { source, model: 'polygon-model' })),
    sub: (agent) => said(ev('SubagentStart', { agent_id: agent, agent_type: 'general-purpose' })),
    bash: (id, command, agent) => said(ev('PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...(agent ? { agent_id: agent } : {}) })),
  };
}

module.exports = {
  id: 'H14', level: 'hook', mech: 'delivery', title: 'Подача: один показ в эпохе, снова после компакции и в субагенте (12)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const env = { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, 'data-h14') };

    fs.writeFileSync(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['delivery'] }));
    const s = session(pluginDir, repo, env);
    const brief1 = s.start('startup');
    const r1 = s.bash('t1', CD);
    const r2 = s.bash('t2', CD);
    const other = s.bash('t3', 'git add -A');
    const briefResume = s.start('resume');
    const r3 = s.bash('t4', CD);
    const briefCompact = s.start('compact');
    const r4 = s.bash('t5', CD);
    s.sub('a1');
    const sub1 = s.bash('t6', CD, 'a1');
    const sub2 = s.bash('t7', CD, 'a1');

    fs.rmSync(path.join(proj, 'canary.json'));
    const c = session(pluginDir, repo, { ...env, HUB_LOG_DIR: path.join(work, 'data-h14-control') });
    c.start('startup');
    const c1 = c.bash('t1', CD), c2 = c.bash('t2', CD);

    const has = (s) => /sed-in-place/.test(s);
    return [
      { id: 'first-shown', source: SRC, pass: has(r1), detail: `первое напоминание: ${r1.slice(0, 80) || 'пусто'}` },
      { id: 'repeat-silent', kind: 'quiet', source: SRC, pass: has(r1) && !has(r2), detail: `повтор в той же эпохе: ${r2.slice(0, 80) || 'пусто'}` },
      { id: 'other-rule-shown', source: SRC, pass: /git-add-all/.test(other), detail: `другое правило: ${other.slice(0, 80) || 'пусто'}` },
      { id: 'resume-same-epoch', kind: 'quiet', source: SRC, pass: brief1.trim() !== '' && briefResume.trim() === '' && !has(r3),
        detail: `бриф startup ${brief1.length} знаков, после resume ${briefResume.length}; напоминание после resume: ${has(r3)}` },
      { id: 'compact-new-epoch', source: SRC, pass: briefCompact.trim() !== '' && has(r4), detail: `после компакции бриф ${briefCompact.length} знаков, напоминание: ${has(r4)}` },
      { id: 'subagent-own-epoch', source: SRC, pass: has(sub1) && !has(sub2), detail: `субагент: первый ${has(sub1)}, повтор ${has(sub2)}` },
      { id: 'control-outside-canary', source: 'контроль: подача 08 вне канарейки', pass: has(c1) && has(c2),
        detail: `вне канарейки напоминание оба раза: ${has(c1)}, ${has(c2)}` },
    ];
  },
};
