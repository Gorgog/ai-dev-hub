// rules-guard: напоминание (или запрос) там, где правило нарушено, и тишина там, где нет. Ложное напоминание —
// шум в контексте на каждый Bash (аудит №3: 2073 срабатывания cd-no-subshell, ложные на `( cd … )`).
'use strict';
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { realCorpus } = require('../lib/corpus.cjs');
const { runEvent, preToolVerdict } = require('../lib/hooks.cjs');

const RG = 'rules-guard.log проекта A';
// [id, command, expectFlag, source]
const CORPUS = [
  ['cd-bare', 'cd /r/apps/api && npm test', false, 'cd-no-subshell снято 05.11: переменная держит cwd, живой дрейф 0'],
  ['cd-bare-after-newline', 'export A=1\ncd /r/apps/api', false, 'cd-no-subshell снято 05.11: переменная держит cwd, живой дрейф 0'],
  ['cd-subshell', '( cd /r/apps/api && npm test )', false, 'аудит №3 (ложные на `( cd … )`)'],
  ['cd-subshell-after-date', '( date +%H:%M; cd /r/memory/snippets && ls )', false, `${RG} / dispatch-guard.log 2026-11-04 case-03`],
  ['cd-in-heredoc-text', "cat >> notes.md <<'EOF'\ncd apps && npm test — так нельзя\nEOF", false, 'синтетика: текст урока в heredoc'],
  ['git-C', 'git -C /r status --short', false, 'base-rules cd-no-subshell (рекомендованная форма)'],
  ['add-all', 'git add -A', true, 'base-rules git-add-all; errors-index 2026-09-20'],
  ['add-dot-C', 'git -C /r add .', true, 'base-rules git-add-all'],
  ['add-path', 'git add ./src/a.ts', false, 'base-rules git-add-all'],
  ['add-in-commit-msg', 'git commit -m "убрал git add . из скрипта"', false, 'синтетика: команда в тексте сообщения'],
  ['push', 'git push origin DEMO-1', true, 'base-rules push (ask)'],
  ['push-in-echo', 'echo "git push — только по ответу"', false, 'синтетика: команда в тексте'],
  ['sed-i', "sed -i 's/a/b/' f.txt", true, 'base-rules sed-in-place'],
  ['sed-n', 'sed -n 1,5p f.txt', false, 'base-rules sed-in-place'],
];

module.exports = {
  id: 'H03', level: 'hook', mech: 'rules-guard', proto: true, title: 'rules-guard: попадание напоминаний', CORPUS,
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work);
    const cwd = path.join(proj, 'repo');
    require('fs').mkdirSync(cwd, { recursive: true });
    const cases = CORPUS.map(([id, command, expect, source]) => ({ id, command, expect, source })).concat(realCorpus('H03') || []);
    return cases.map(({ id, command, expect, source, real }) => {
      const { verdict, reasons } = preToolVerdict(runEvent(pluginDir, 'PreToolUse', { hook_event_name: 'PreToolUse',
        session_id: 'eval', cwd, tool_name: 'Bash', tool_input: { command } }, { AI_DEV_HUB: hub }));
      const flagged = verdict !== 'allow';
      return { id, source, real, kind: expect ? 'catch' : 'quiet', pass: flagged === expect,
        detail: `ждали ${expect ? 'флаг' : 'тишину'}, вышло ${verdict}${reasons[0] ? ': ' + reasons[0].slice(0, 90) : ''}` };
    });
  },
};
