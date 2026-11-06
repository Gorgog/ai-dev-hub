// Срез 36: отметка «уже показан» — только после вывода. Хук, убитый в момент записи в stdout, не оставляет
// напоминание «показанным» в эпохе: следующий вызов подаёт его снова (лучше дважды, чем ни разу). Убийство —
// постановкой, не kill-штормом: preload подменяет process.stdout.write раннера на SIGKILL своего процесса. Контроль —
// тот же вызов без убийства: повтор в эпохе молчит (проверка отличает «показан» от «не показан»).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'срез 36: «урок показан» писался до вывода — убитый хук терял урок в эпохе (урок индекса: выход — после колбэка записи)';
const CMD = "sed -i 's/a/b/' notes.txt"; // the sed-in-place reminder of rules-guard, as in H14
const DIE = "process.stdout.write = function () { process.kill(process.pid, 'SIGKILL'); };\n";

const said = (res) => res.map((r) => (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : '')).join('');
const has = (s) => /sed-in-place/.test(s);

module.exports = {
  id: 'H62', level: 'hook', mech: 'delivery', title: 'Подача: «показан» — после вывода; убитый на выводе хук подаст снова (36)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['delivery'] }));
    const die = path.join(work, 'die-on-write.cjs');
    fs.writeFileSync(die, DIE);

    const session = (sid) => {
      const env = { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, `data-${sid}`) };
      const ev = (event, extra) => ({ hook_event_name: event, session_id: sid, permission_mode: 'default', cwd: repo, ...extra });
      const bashEv = (id) => ev('PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: CMD } });
      return {
        start: () => runEvent(pluginDir, 'SessionStart', ev('SessionStart', { source: 'startup', model: 'polygon-model' }), env),
        bash: (id) => said(runEvent(pluginDir, 'PreToolUse', bashEv(id), env)),
        killed: (id) => spawnSync(process.execPath, ['-r', die, path.join(pluginDir, 'hooks', 'run.cjs'), 'PreToolUse'], {
          input: JSON.stringify(bashEv(id)), encoding: 'utf8', timeout: 20000, env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginDir, ...env } }),
      };
    };

    const s = session('eval-h62');
    s.start();
    const k = s.killed('t1');
    const after = s.bash('t2');
    const again = s.bash('t3');

    const c = session('eval-h62-control');
    c.start();
    const c1 = c.bash('t1');
    const c2 = c.bash('t2');

    return [
      { id: 'killed-at-output-shown-again', source: SRC, pass: k.signal === 'SIGKILL' && k.stdout === '' && has(after),
        detail: `убит: ${k.signal}, вывод ${JSON.stringify(k.stdout)}; следующий вызов: ${after.slice(0, 80) || 'пусто'}` },
      { id: 'shown-once-after-write', kind: 'quiet', source: SRC, pass: has(after) && !has(again), detail: `повтор после вывода: ${again.slice(0, 80) || 'пусто'}` },
      { id: 'control-no-kill-once', observe: true, source: 'контроль: тот же вызов без убийства — повтор в эпохе молчит',
        pass: has(c1) && !has(c2), detail: `без убийства: первый ${has(c1)}, повтор ${has(c2)}` },
    ];
  },
};
