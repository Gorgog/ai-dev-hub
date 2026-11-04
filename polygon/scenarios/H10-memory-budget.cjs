// Контракт механизма (срезы 13, 22): бюджет памяти «с зубами». Правка CLAUDE.md проекта, после которой файл больше
// 20 КБ, — запрос или отказ с отсылкой к memory-gc; мелкая правка небольшого файла — тишина. Заготовка: PreToolUse(Edit).
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent, preToolVerdict } = require('../lib/hooks.cjs');

module.exports = {
  id: 'H10', level: 'hook', mech: 'memory-budget', contract: true, title: 'Бюджет памяти: CLAUDE.md сверх 20 КБ (контракт 13/22)',
  async run({ base, pluginDir, work }) {
    const big = `# Проект: demo\n\n${'- правило проекта, строка для объёма.\n'.repeat(560)}`.slice(0, 20300);
    const { hub, proj } = makeHub(base, work, { claude: big });
    const small = path.join(hub, 'projects', 'small');
    fs.mkdirSync(path.join(small, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(small, 'CLAUDE.md'), '# Проект: small\n\n- одно правило.\n');
    const edit = (cwdProj, file, old, add) => preToolVerdict(runEvent(pluginDir, 'PreToolUse', { hook_event_name: 'PreToolUse',
      session_id: 'eval', cwd: path.join(cwdProj, 'repo'), tool_name: 'Edit',
      tool_input: { file_path: file, old_string: old, new_string: old + add } }, { AI_DEV_HUB: hub }));
    const over = edit(proj, path.join(proj, 'CLAUDE.md'), '# Проект: demo', `\n\n- новое правило: ${'подробность '.repeat(40)}`);
    const tiny = edit(small, path.join(small, 'CLAUDE.md'), '- одно правило.', '\n- второе правило.');
    const src = 'аудит №2 (CLAUDE.md проекта 20 456 / 20 480 байт)';
    return [
      { id: 'over-20kb-asks', source: src, pass: over.verdict !== 'allow' && over.verdict !== 'log' && /memory-gc/i.test(over.reasons.join(' ')),
        detail: `ждали ask/deny с memory-gc, вышло ${over.verdict}${over.reasons[0] ? ': ' + over.reasons[0].slice(0, 100) : ''}` },
      { id: 'small-edit-quiet', kind: 'quiet', source: src, pass: tiny.verdict === 'allow',
        detail: `ждали тишину, вышло ${tiny.verdict}: ${(tiny.reasons[0] || '').slice(0, 100)}` },
    ];
  },
};
