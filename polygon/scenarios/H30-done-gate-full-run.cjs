// «Готово к пушу» по фактам: в проекте с checks.json доклад проходит, только если `checks --full` прогнан на итоговом
// HEAD чистого дерева и зелёный (`last-full.json` в git-папке worktree). Факт среза 11: 35 из 59 докладов — без
// полного прогона после последнего коммита (чаще коммит доков после прогона). Срез 16.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent, stopVerdict } = require('../lib/hooks.cjs');

module.exports = {
  id: 'H30', level: 'hook', mech: 'done-gate', title: 'Доклад «готово к пушу»: checks --full на итоговом HEAD',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work, { extra: {
      'canary.json': JSON.stringify({ mechanisms: ['done-gate'] }),
      'checks.json': JSON.stringify({ base: 'main', fast: [], full: [{ name: 'test', cmd: 'true' }] }) } });
    const repo = path.join(proj, 'repo');
    const git = gitRepo(repo, { 'a.txt': '1\n' });
    const wt = path.join(proj, 'worktrees', 'DEMO-6');
    git('worktree', 'add', '-q', '-b', 'DEMO-6', wt);
    const commit = (file, msg) => { fs.writeFileSync(path.join(wt, file), `${file}\n`); git('-C', wt, 'add', file); git('-C', wt, 'commit', '-q', '-m', msg); return git('-C', wt, 'rev-parse', 'HEAD'); };
    const lastFull = git('-C', wt, 'rev-parse', '--path-format=absolute', '--git-path', 'hub/last-full.json');
    const full = (data) => { fs.mkdirSync(path.dirname(lastFull), { recursive: true }); fs.writeFileSync(lastFull, JSON.stringify({ at: new Date().toISOString(), ...data })); };
    const stop = (sha) => stopVerdict(runEvent(pluginDir, 'Stop', { hook_event_name: 'Stop', session_id: 'eval', cwd: wt,
      last_assistant_message: `Готово к пушу: DEMO-6, HEAD ${sha.slice(0, 7)}, тесты 3/3, дерево чистое.`, stop_hook_active: false }, { AI_DEV_HUB: hub }));
    const src = 'срез 11: 35/59 докладов без checks --full после последнего коммита; правило 3 хаба';
    const checks = [];
    const add = (id, r, expectBlock, re) => checks.push({ id, source: src, kind: expectBlock ? 'catch' : 'quiet',
      pass: r.block === expectBlock && (!re || re.test(r.reason)),
      detail: `ждали ${expectBlock ? 'блок' : 'пропуск'}, вышло ${r.block ? 'блок: ' + r.reason.slice(0, 120) : 'пропуск'}` });

    let head = commit('b.txt', 'feat: b');
    add('no-full-run', stop(head), true, /--full/);
    full({ sha: head, code: 0, clean: true, steps: [{ name: 'test', status: 'OK' }] });
    add('full-green-on-head', stop(head), false);
    head = commit('NOTES.md', 'docs: заметка');
    add('docs-commit-after-full', stop(head), true, /docs: заметка/);
    full({ sha: head, code: 1, clean: true, steps: [{ name: 'test', status: 'FAIL' }] });
    add('full-red', stop(head), true, /test/);
    full({ sha: head, code: 0, clean: false, steps: [{ name: 'test', status: 'OK' }] });
    add('full-on-dirty-tree', stop(head), true);
    full({ sha: head, code: 0, clean: true, steps: [{ name: 'test', status: 'OK' }] });
    add('full-green-again', stop(head), false);
    return checks;
  },
};
