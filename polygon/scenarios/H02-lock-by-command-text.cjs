// Замок диспетчера без гранта: что блокируется. Корпус — команды из dispatch-guard.log проекта A (ложные блоки,
// пути обезличены) и синтетические обходы (тяжёлое без гранта). Правила — копия dispatch-rules.json проекта.
// Мини-проект включает канарейку lock-program (срез 15, замок по программе): на версии хаба с этим модулем меряется
// он, на версии без него (v1, main до 15) — прежний замок по тексту.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { realCorpus, realFile } = require('../lib/corpus.cjs');
const { runEvent, preToolVerdict } = require('../lib/hooks.cjs');

const LOG = 'dispatch-guard.log проекта A';
// [id, tool, input, expectBlocked, source]
const CORPUS = [
  // Лёгкое, которое блокировалось (ложные блоки).
  ['fp-grep-jest-text', 'Bash', { command: 'grep -n "timeout 1200 npx jest --testPathIgnorePatterns" /tmp/s/batches.sh' }, false, `${LOG} 2026-11-02 case-01`],
  ['fp-sed-ls-env', 'Bash', { command: 'sed -n 1,40p memory/snippets/test-all-batches.sh; ls apps/backend/.env.test' }, false, `${LOG} 2026-11-04 case-02`],
  ['fp-node-check', 'Bash', { command: 'node --check /tmp/s/memory/snippets/shots-login.cjs' }, false, `${LOG} 2026-11-03 case-03`],
  ['fp-commit-msg-kubb', 'Bash', { command: 'git add apps/frontend/src/kubb/gen/types/X.ts && git commit -m "fix: типы после kubb generate"' }, false, `${LOG} 2026-11-02 case-04`],
  ['fp-heredoc-lesson', 'Bash', { command: "cat >> memory/errors.md <<'EOF'\n- урок: npx playwright без гранта не запускать\nEOF" }, false, `${LOG} 2026-11-04 case-05`],
  ['fp-fmt-snippet', 'Bash', { command: 'node memory/snippets/fmt-own.cjs src/a.ts' }, false, `${LOG} 2026-10-29 case-06 (форматтер, не проба)`],
  ['fp-preview-external', 'mcp__Claude_Browser__preview_start', { url: 'https://example.com/docs' }, false, 'коммит хаба ef519e3 (внешний url — лёгкое)'],
  // Тяжёлое и среднее, которое должно блокироваться.
  ['tp-jest', 'Bash', { command: 'npx jest src/a.spec.ts' }, true, `${LOG} 2026-10-20`],
  ['tp-npm-ci', 'Bash', { command: 'npm ci' }, true, `${LOG} 2026-10-20`],
  ['tp-tsc-subshell', 'Bash', { command: '( cd apps/frontend && npx tsc --noEmit )' }, true, `${LOG} 2026-10-19 case-07`],
  ['tp-playwright', 'Bash', { command: 'npx playwright test' }, true, 'dispatch-rules «playwright и пробы»'],
  ['tp-migrate', 'Bash', { command: 'npx prisma migrate deploy' }, true, 'dispatch-rules «дев-БД и миграции»'],
  ['tp-preview-devserver', 'mcp__Claude_Browser__preview_start', { name: 'frontend' }, true, `${LOG} 2026-11-03 case-03`],
  // Обходы: тяжёлое другим написанием (аудит 04.11: «прогоны без гранта прошли»).
  ['fn-npm-prefix-dev', 'Bash', { command: 'npm --prefix apps/frontend run dev' }, true, 'синтетика (аудит №6)'],
  ['fn-npx-yes-jest', 'Bash', { command: 'npx --yes jest src/a.spec.ts' }, true, 'синтетика (аудит №6)'],
  ['fn-pnpm-playwright', 'Bash', { command: 'pnpm exec playwright test' }, true, 'синтетика (аудит №6)'],
  ['fn-jest-bin', 'Bash', { command: 'node node_modules/jest/bin/jest.js src/a.spec.ts' }, true, 'синтетика (аудит №6)'],
  ['fn-script-runs-jest', 'Bash', { command: 'bash scripts/test-batch.sh' }, true, 'синтетика: скрипт внутри зовёт npx jest'],
  // После прототипа (proto: false — не входят в строку «прототип H01–H04», базовая линия остаётся 24/45).
  ['tp-polygon-model', 'Bash', { command: 'node polygon/run.cjs --model claude-opus-5-5 --only M01' }, true, 'правило замка проекта хаба 05.11', false],
  ['fn-polygon-level-model', 'Bash', { command: 'node polygon/run.cjs --level model --repeats 3 --only M01' }, true,
    'замок проекта хаба 05.11: правило ловило только --model, --level model прошёл мимо', false],
  // Замок по программе (срез 15): ещё обходы обёртками и переменными и упоминания в тексте — вне прототипа.
  ['fn-env-timeout-jest', 'Bash', { command: 'env CI=1 timeout 600 npx jest src/a.spec.ts' }, true, 'синтетика 15: обёртки env и timeout', false],
  ['fn-bash-c-playwright', 'Bash', { command: 'bash -c "npx playwright test"' }, true, 'синтетика 15: строка-код bash -c', false],
  ['fn-var-program', 'Bash', { command: 'R=jest; npx $R src/a.spec.ts' }, true, 'синтетика 15: программа в переменной', false],
  ['fn-yarn-dev', 'Bash', { command: 'yarn dev' }, true, 'синтетика 15: скрипт пакета через yarn', false],
  ['fn-cd-subshell-script', 'Bash', { command: '( cd scripts && ./test-batch.sh )' }, true, 'синтетика 15: скрипт из подоболочки после cd', false],
  ['fp-git-log-grep', 'Bash', { command: 'git log --oneline --grep "npx jest"' }, false, 'синтетика 15: упоминание в аргументе', false],
  ['fp-echo-npm-ci', 'Bash', { command: 'echo "дальше: npm ci, потом npx tsc"' }, false, 'синтетика 15: упоминание в echo', false],
  ['fp-cat-script', 'Bash', { command: 'cat scripts/test-batch.sh && sed -n 1,5p scripts/test-batch.sh' }, false, 'синтетика 15: чтение скрипта, не запуск', false],
];

module.exports = {
  id: 'H02', level: 'hook', mech: 'lock', proto: true, title: 'Замок диспетчера: блок по тексту команды', CORPUS,
  async run({ base, pluginDir, work }) {
    const checks = judge(base, pluginDir, path.join(work, 'syn'), path.join(__dirname, '..', 'fixtures', 'dispatch-rules.json'),
      CORPUS.map(([id, tool, input, expect, source, proto]) => ({ id, tool, input, expect, source, proto })));
    // Реальный корпус — со своими правилами живого проекта, если они лежат рядом (H02-rules.json), иначе с синтетикой.
    const real = realCorpus('H02');
    if (real) checks.push(...judge(base, pluginDir, path.join(work, 'real'),
      realFile('H02-rules.json') || path.join(__dirname, '..', 'fixtures', 'dispatch-rules.json'), real));
    return checks;
  },
};

// One mini-hub with the given lock rules, no grants; every case is one PreToolUse event.
function judge(base, pluginDir, work, rules, cases) {
  fs.mkdirSync(work, { recursive: true });
  const { hub, proj } = makeHub(base, work);
  fs.copyFileSync(rules, path.join(proj, 'dispatch-rules.json'));
  fs.writeFileSync(path.join(proj, 'memory', 'dispatch-grants.json'), '{}\n');
  fs.writeFileSync(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: ['lock-program'] }) + '\n');
  const cwd = path.join(proj, 'worktrees', 'DEMO-5');
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'scripts', 'test-batch.sh'), '#!/bin/sh\nnpx jest "$@"\n');
  return cases.map(({ id, tool, input, expect, source, real, proto }) => {
    const { verdict, reasons } = preToolVerdict(runEvent(pluginDir, 'PreToolUse', { hook_event_name: 'PreToolUse',
      session_id: 'eval', cwd, tool_name: tool, tool_input: input }, { AI_DEV_HUB: hub }));
    const blocked = verdict === 'deny';
    return { id, source, real, proto, kind: expect ? 'catch' : 'quiet', pass: blocked === expect,
      detail: `ждали ${expect ? 'блок' : 'пропуск'}, вышло ${verdict}${reasons[0] ? ': ' + reasons[0].split('\n')[0].slice(0, 100) : ''}` };
  });
}
