// Целостность и лимиты памяти на старте сессии: NUL в errors.md (grep пропускает файл), CLAUDE.md у самого лимита,
// длинные строки индекса, разросшийся decisions.md. Механизм хаба — бриф SessionStart.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

module.exports = {
  id: 'H04', level: 'hook', title: 'Память: целостность и лимиты на старте',
  async run({ base, pluginDir, work }) {
    const lessons = Array.from({ length: 300 }, (_, i) => `- (2026-10-${String(1 + (i % 28)).padStart(2, '0')}) урок ${i}: синтетика.`);
    lessons[120] = `- (2026-10-12) урок с мусором ${'\u0000'} после вставки.`; // как в errors.md проекта A
    const longLine = `- ${'длинное правило индекса '.repeat(9)}(10-12)`; // > 160 знаков
    const claude = `# Проект: demo\n\n${'- правило проекта, строка для объёма.\n'.repeat(560)}`.slice(0, 20456);
    const { hub, proj } = makeHub(base, work, {
      claude,
      memory: {
        'errors.md': `# Ошибки\n\n${lessons.join('\n')}\n`,
        'errors-index.md': `# Индекс\n## Git — ключи: \`git add\`\n${longLine}\n- короткое правило (09-20)\n`,
        'decisions.md': `# Решения\n\n${'- решение: синтетика для объёма, строка в восемьдесят знаков примерно так.\n'.repeat(7000)}`,
      },
    });
    const repo = path.join(proj, 'repo');
    gitRepo(repo, { 'a.txt': '1\n' });
    const out = runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'eval', cwd: repo },
      { AI_DEV_HUB: hub }).map((r) => r.stdout + (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : '')).join('\n');
    const has = (re) => re.test(out);
    return [
      { id: 'nul-in-errors', source: 'аудит №1: NUL в errors.md проекта A, 264 урока не ищутся',
        pass: has(/errors\.md[^\n]*(NUL|\\0|двоичн|бинарн|binary|нечита)/i), detail: 'бриф молчит о NUL в errors.md' },
      { id: 'claude-md-limit', source: 'аудит №2: CLAUDE.md проекта 20 456 / 20 480 байт',
        pass: has(/CLAUDE\.md[^\n]*(лимит|КБ|байт|20)/i), detail: 'бриф молчит о CLAUDE.md у лимита' },
      { id: 'index-long-lines', source: 'аудит №2: 122 из 150 строк индекса > 160 знаков',
        pass: has(/индекс[^\n]*160/i), detail: 'бриф молчит о длинных строках индекса' },
      { id: 'decisions-size', source: 'аудит №2: decisions.md 567 КБ',
        pass: has(/decisions\.md/i), detail: 'бриф молчит о размере decisions.md' },
      { id: 'brief-budget', source: 'session-start.cjs BUDGET', observe: true,
        pass: out.length <= 10000, detail: `длина брифа ${out.length}` },
    ];
  },
};
