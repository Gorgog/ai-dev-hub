// Приёмочный тест памяти 2 на SessionStart (срез 21, модуль memory-check): старт проекта с памятью v2 называет в
// брифе каждую порчу — NUL в уроке, рваную строку событий, битый индекс (пересобирает его) — и не блокирует старт.
// Содержимое — проверка памяти среза 14 (store.check). Модуль в стадии canary: фикстура включает его canary.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'acceptance §2 тест 2 [Г]: «SessionStart называет каждую; ни один вызов не заблокирован»';
const lesson = (id, first) => ['---', `id: ${id}`, 'kind: rule', 'when: []', 'keys: []', 'status: active', 'supersedes: []',
  'source: модель', 'created: 2026-11-01', '---', first, 'Вторая строка.', ''].join('\n');

module.exports = {
  id: 'H25', level: 'hook', mech: 'memory-hooks', title: 'SessionStart называет порчу памяти v2 (21)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work, {
      memory: {
        'lessons/ok-one.md': lesson('ok-one', 'Целый урок.'),
        'lessons/nul-one.md': `${lesson('nul-one', 'Урок с мусором.')}хвост \u0000 из буфера\n`,
        'events/2026-11.jsonl': '{"at":"2026-11-01T00:00:00Z","kind":"shown","lesson":"ok-one"}\n{"at":"2026-11-0',
        '.index.db': 'мусор вместо базы',
      },
      extra: { 'canary.json': JSON.stringify({ mechanisms: ['delivery', 'memory'] }) },
    });
    const repo = path.join(proj, 'repo');
    gitRepo(repo, { 'a.txt': '1\n' });
    const res = runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'eval', cwd: repo },
      { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, 'data') });
    const out = res.map((r) => r.stdout + (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : '')).join('\n');
    const blocked = res.some((r) => r.code === 2 || (r.json && (r.json.continue === false || r.json.decision === 'block')));
    return [
      { id: 'names-nul-lesson', source: SRC, pass: /nul-one\.md[^\n]*NUL/.test(out), detail: 'бриф молчит о NUL в уроке' },
      { id: 'names-torn-event', source: SRC, pass: /2026-11\.jsonl:2/.test(out), detail: 'бриф молчит о рваной строке событий' },
      { id: 'names-broken-index', source: SRC, pass: /индекс[^\n]*(бит|пересобран)/i.test(out), detail: 'бриф молчит о битом индексе' },
      { id: 'not-blocked', kind: 'quiet', source: SRC, pass: !blocked, detail: 'SessionStart заблокировал старт' },
      { id: 'index-rebuilt', source: SRC, pass: fs.readFileSync(path.join(proj, 'memory', '.index.db')).subarray(0, 15).toString() === 'SQLite format 3',
        detail: 'индекс после старта не пересобран' },
    ];
  },
};
