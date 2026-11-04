// Контракт механизма (срезы 16, 18): чек-лист «готово к пушу» — механизмом, а не памятью сессии. Доклад из ветки,
// которая отстала от main, не проходит; из ветки поверх свежей main — проходит. Заготовка: Stop-хук; срез, который
// сделает механизм (стоп-хук или push-slice), уточняет вход вместе со сценарием.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent, stopVerdict } = require('../lib/hooks.cjs');

module.exports = {
  id: 'H09', level: 'hook', mech: 'done-gate', contract: true, title: 'Чек-лист «готово к пушу»: ветка отстала от main (контракт 16/18)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const repo = path.join(proj, 'repo');
    const git = gitRepo(repo, { 'a.txt': '1\n' });
    const wt = (name) => {
      const d = path.join(proj, 'worktrees', name);
      git('worktree', 'add', '-q', '-b', name, d);
      fs.writeFileSync(path.join(d, `${name}.txt`), `${name}\n`);
      git('-C', d, 'add', `${name}.txt`);
      git('-C', d, 'commit', '-q', '-m', name);
      return { d, head: git('-C', d, 'rev-parse', '--short', 'HEAD') };
    };
    const behind = wt('DEMO-9');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'main moved\n');
    git('add', 'c.txt');
    git('commit', '-q', '-m', 'main moved');
    const fresh = wt('DEMO-8');
    const stop = (cwd, msg) => stopVerdict(runEvent(pluginDir, 'Stop', { hook_event_name: 'Stop', session_id: 'eval', cwd,
      last_assistant_message: msg, stop_hook_active: false }, { AI_DEV_HUB: hub }));
    const a = stop(behind.d, `Готово к пушу: DEMO-9, HEAD ${behind.head}, тесты 3/3, дерево чистое.`);
    const b = stop(fresh.d, `Готово к пушу: DEMO-8, HEAD ${fresh.head}, тесты 3/3, дерево чистое.`);
    const src = 'аудит №4; errors 11-04 «забыл про правила» (чек-лист пуша диспетчера)';
    return [
      { id: 'behind-main-blocked', source: src, pass: a.block, detail: `ждали блок, вышло ${a.block ? 'блок' : 'пропуск'}` },
      { id: 'up-to-date-passes', kind: 'quiet', source: src, pass: !b.block, detail: `ждали пропуск, вышло блок: ${b.reason.slice(0, 120)}` },
    ];
  },
};
