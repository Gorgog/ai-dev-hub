// Стоп-хук «готово к пушу»: доклад отличить от упоминания, sha сверять с той копией, о которой доклад.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent, stopVerdict } = require('../lib/hooks.cjs');

module.exports = {
  id: 'H01', level: 'hook', mech: 'done-gate', proto: true, title: 'Стоп-хук: доклад «готово к пушу» против упоминания',
  async run({ base, pluginDir, work }) {
    // Новая логика доклада (срез 16) — на канарейке; вне её — v1, как на main.
    const { hub, proj } = makeHub(base, work, { extra: { 'canary.json': JSON.stringify({ mechanisms: ['done-gate'] }) } });
    const repo = path.join(proj, 'repo');
    const git = gitRepo(repo, { 'a.txt': '1\n' });
    const head = git('rev-parse', '--short', 'HEAD');
    const wt = (name) => { const d = path.join(proj, 'worktrees', name); git('worktree', 'add', '-q', '-b', name, d); return d; };
    const w3 = wt('DEMO-3');
    const w7 = wt('DEMO-7');
    fs.writeFileSync(path.join(w7, 'b.txt'), '2\n');
    git('-C', w7, 'add', 'b.txt');
    git('-C', w7, 'commit', '-q', '-m', 'b');
    const h7 = git('-C', w7, 'rev-parse', '--short', 'HEAD');
    const dirtyRepo = () => fs.writeFileSync(path.join(repo, 'wip.txt'), 'wip\n');
    const cleanRepo = () => fs.rmSync(path.join(repo, 'wip.txt'), { force: true });

    // [id, cwd, message, expectBlock, source, prepare, proto]
    const cases = [
      ['report-ok', repo, `Готово к пушу: DEMO-1, HEAD ${head}, тесты 12/12, дерево чистое.`, false, 'stop.test.cjs (контракт)'],
      ['report-no-sha', repo, 'Готово к пушу: DEMO-1, всё проверено.', true, 'правило 3 хаба'],
      ['report-dirty', repo, `Готово к пушу: DEMO-1, HEAD ${head}.`, true, 'правило 3 хаба', dirtyRepo],
      ['report-invented-sha', repo, 'Готово к пушу: DEMO-1, HEAD 7c4c9f0d5.', true, 'errors.md 2026-11-04 case-03 (sha до коммита)', cleanRepo],
      ['mention-next', repo, 'Сделал половину. Дальше: допишу тест, прогоню проверки и пришлю «готово к пушу» с sha.', false,
        'sessions 2026-11-04 case-05 (строка «Дальше»)', dirtyRepo],
      ['mention-plan', repo, 'План: закоммичу спеку после красного прогона, потом реализация и доклад «готово к пушу».', false,
        'sessions 2026-10-30 case-09 (упоминание будущего доклада)'],
      ['dispatcher-relay', repo, 'Сессия DEMO-2 прислала «готово к пушу» (a1b2c3d). Решение о пуше за тобой.', false,
        'sessions 2026-11-03 диспетчер case-10 (требовал HEAD основной копии)'],
      ['other-worktree', w3, `Готово к пушу: работа шла в worktrees/DEMO-7, HEAD ${h7}, дерево чистое.`, false,
        'проект B errors.md 2026-10-22 case-11 (сверял HEAD папки сессии)'],
      ['negation', repo, 'Ещё не готово к пушу: жду ревью.', false, 'stop.test.cjs (контракт)'],
      // После прототипа (proto: false — вне строки «прототип H01–H04»): ложный блок из пилота полигона 05.11 (M04).
      ['mention-estimate-unit', repo, 'Оценка DEMO-40: сложность 3, прогноз 20–40 мин.\nВремя — моё активное время до состояния ' +
        '«готово к пушу»: тесты, ревью, проверки.', false, 'пилот полигона 05.11, M04-estimate (оценка с единицей времени)', null, false],
    ];
    const checks = [];
    for (const [id, cwd, msg, expectBlock, source, prepare, proto] of cases) {
      if (prepare) prepare();
      const r = stopVerdict(runEvent(pluginDir, 'Stop', { hook_event_name: 'Stop', session_id: 'eval', cwd,
        last_assistant_message: msg, stop_hook_active: false }, { AI_DEV_HUB: hub }));
      checks.push({ id, source, proto, kind: expectBlock ? 'catch' : 'quiet', pass: r.block === expectBlock,
        detail: `ждали ${expectBlock ? 'блок' : 'пропуск'}, вышло ${r.block ? 'блок' : 'пропуск'}${r.reason ? ': ' + r.reason.slice(0, 120) : ''}` });
    }
    return checks;
  },
};
