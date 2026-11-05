// Вывод тестов «зелёный» по коду выхода, а в сводке упавшие или пропущенные (vitest/jest/node --test за `| tail`,
// `|| echo`): PostToolUse сразу подаёт напоминание со строкой сводки (блок шумел: 2,8 % Bash, в основном намеренно
// красные TDD); честно зелёный прогон — тишина. Срез 16.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const OUT = {
  'vitest-failed': ' Test Files  1 failed | 4 passed (5)\n      Tests  1 failed | 41 passed (42)\n   Duration  1.20s',
  'jest-failed': 'Test Suites: 1 failed, 3 passed, 4 total\nTests:       2 failed, 30 passed, 32 total\nTime:        3.1 s',
  'jest-skipped': 'Test Suites: 4 passed, 4 total\nTests:       4 skipped, 30 passed, 34 total\nTime:        2.0 s',
  'node-loop-failed': '# tests 3\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\nFAIL plugin/a.test.cjs',
  'vitest-green': ' Test Files  5 passed (5)\n      Tests  42 passed (42)\n   Duration  1.00s',
  'jest-green': 'Test Suites: 4 passed, 4 total\nTests:       32 passed, 32 total\nTime:        2.9 s',
  'cat-fixture': "const OUT = 'Tests:       2 failed, 30 passed, 32 total';",
};

module.exports = {
  id: 'H28', level: 'hook', mech: 'done-gate', title: 'Вывод тестов: exit 0 при упавших или пропущенных — напоминание',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work, { extra: { 'canary.json': JSON.stringify({ mechanisms: ['done-gate'] }) } });
    const src = 'план 16: vitest/jest exit 0 при failed/skipped; хаб: цикл тестов `|| echo FAIL`';
    return Object.entries(OUT).map(([id, stdout]) => {
      const expectBlock = !/green|fixture/.test(id);
      const res = runEvent(pluginDir, 'PostToolUse', { hook_event_name: 'PostToolUse', session_id: `eval-${id}`, cwd: proj,
        tool_name: 'Bash', tool_input: { command: 'npm test 2>&1 | tail -5' }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false } },
      { AI_DEV_HUB: hub });
      const ctx = res.map((x) => (x.json && x.json.hookSpecificOutput && x.json.hookSpecificOutput.additionalContext) || '').join('\n');
      const blocked = res.some((x) => x.code === 2 || (x.json && x.json.decision === 'block'));
      const said = /не зелёный/.test(ctx) && !blocked;
      return { id, source: src, kind: expectBlock ? 'catch' : 'quiet', pass: said === expectBlock && !blocked,
        detail: `ждали ${expectBlock ? 'напоминание' : 'тишину'}, вышло ${blocked ? 'блок' : said ? 'напоминание' : 'тишина'}` };
    });
  },
};
