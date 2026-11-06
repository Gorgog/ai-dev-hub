// Срез 29 (memory-core, канарейка): старт проекта с памятью v2 подаёт ядро уроков (status core, ≤ 15 строк) вместо
// рукописного индекса errors-index.md, остальное — по касанию; бриф заметно короче. Вне канарейки и в проекте без
// memory/lessons/ — прежний бриф memory-brief (индекс целиком). Через настоящий раннер SessionStart.
'use strict';
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'план 29 (What): «бриф подаёт выводимое ядро уроков вместо рукописного индекса; проект старого формата — прежний бриф»';
const SIZE = 'acceptance §3 «Постоянный контекст на старте ≤ 30 КБ» [П] — бриф ядра короче брифа индекса';
const INDEX_LINE = '- строка рукописного индекса проекта: в бриф v2 не идёт';
// A realistic index: the brief of v1 carries all of it (budget 9500).
const INDEX = ['# Индекс правил из ошибок — demo', '', '## Тема — ключи: `x`', INDEX_LINE,
  ...Array.from({ length: 40 }, (_, i) => `- правило индекса номер ${i + 1}: длинное пояснение, где и почему так вышло, с примером (2026-10-22)`), ''].join('\n');
const lesson = (id, status, first) => ['---', `id: ${id}`, 'kind: rule', 'when: []', `keys: [${id}]`, `status: ${status}`,
  'supersedes: []', 'source: модель', 'created: 2026-11-01', '---', first, 'Подробности урока — в бриф не идут.', ''].join('\n');
const LESSONS = {
  'lessons/core-cd.md': lesson('core-cd', 'core', '`cd` — только в подоболочке.'),
  'lessons/core-push.md': lesson('core-push', 'core', 'Пуш — только по слову пользователя.'),
  'lessons/touch-css.md': lesson('touch-css', 'active', 'Стили base — в @layer base.'),
};

function start(base, pluginDir, work, tag, { lessons, canary }) {
  const root = path.join(work, tag);
  const { hub, proj } = makeHub(base, root, {
    memory: { 'errors-index.md': INDEX, ...(lessons ? LESSONS : {}) },
    extra: { 'canary.json': JSON.stringify({ mechanisms: canary }) },
  });
  const repo = path.join(proj, 'repo');
  gitRepo(repo, { 'a.txt': '1\n' });
  const res = runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: `eval-${tag}`, cwd: repo },
    { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(root, 'data'), CLAUDE_PLUGIN_DATA: path.join(root, 'pdata') });
  return res.map((r) => r.stdout + (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : '')).join('\n');
}

module.exports = {
  id: 'H53', level: 'hook', mech: 'memory-core', title: 'Бриф v2: ядро уроков вместо индекса (29)',
  async run({ base, pluginDir, work }) {
    const v2 = start(base, pluginDir, work, 'v2', { lessons: true, canary: ['delivery', 'memory-core'] });
    const off = start(base, pluginDir, work, 'off', { lessons: true, canary: ['delivery'] });
    const v1 = start(base, pluginDir, work, 'v1', { lessons: false, canary: ['delivery', 'memory-core'] });
    const bytes = (s) => Buffer.byteLength(s);
    return [
      { id: 'core-lines', source: SRC, pass: /`cd` — только в подоболочке\. \[core-cd\]/.test(v2) && /\[core-push\]/.test(v2),
        detail: 'в брифе v2 нет строк ядра уроков' },
      { id: 'no-index', source: SRC, pass: !v2.includes(INDEX_LINE) && !/Правила из ошибок \(memory\/errors-index\.md\)/.test(v2),
        detail: 'бриф v2 всё ещё несёт рукописный индекс' },
      { id: 'touch-pointer', source: SRC, pass: /по касанию/i.test(v2) && /recall/.test(v2) && !/layer base/.test(v2),
        detail: 'нет указателя на уроки по касанию или урок active подан целиком' },
      { id: 'off-canary-old', kind: 'quiet', source: SRC, pass: off.includes(INDEX_LINE) && !/\[core-cd\]/.test(off),
        detail: 'вне канарейки бриф изменился' },
      { id: 'v1-project-old', kind: 'quiet', source: SRC, pass: v1.includes(INDEX_LINE) && !/Ядро уроков/.test(v1),
        detail: 'проект без memory/lessons/ на канарейке потерял прежний бриф' },
      { id: 'smaller', source: SIZE, pass: bytes(v2) > 0 && bytes(v2) * 2 < bytes(off),
        detail: `бриф ядра ${bytes(v2)} Б не вдвое короче брифа индекса ${bytes(off)} Б` },
    ];
  },
};
