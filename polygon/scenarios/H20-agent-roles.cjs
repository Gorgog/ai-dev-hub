// agent-roles: тестировщик пишет только тесты, ревьюер и разведчик не пишут в рабочий репозиторий и не меняют его git,
// никто не пишет память агента в .claude/agent-memory, роли — память проекта хаба. Своё (scratchpad, /tmp, свой
// временный репозиторий) — можно. Журналы проекта A до 05.11: ревьюер дописывал .claude/agent-memory/reviewer и
// делал мутации sed -i + git checkout прямо в дереве автора.
'use strict';
const { judge, cases } = require('./H17-protect-files.cjs');

const J = 'журналы проекта A до 05.11';
// [id, tool, input, expectDeny, source, agent_type]
const CORPUS = [
  ['reviewer-write-src', 'Write', { file_path: 'src/a.ts', content: 'x' }, true, 'reviewer.md (ревьюер не пишет)', 'hub:reviewer'],
  ['reviewer-mutation', 'Bash', { command: "sed -i 's/= 1/= 2/' src/a.ts && npx jest src/a.test.ts; git checkout -- src/a.ts" }, true, `${J}: мутации в дереве автора`, 'reviewer'],
  ['reviewer-redirect-repo', 'Bash', { command: 'git diff main..HEAD > review.diff' }, true, 'ревьюер не пишет файлов', 'hub:reviewer'],
  ['reviewer-stash', 'Bash', { command: 'git stash push -m probe' }, true, 'ревьюер не меняет git', 'hub:reviewer'],
  ['reviewer-agent-memory', 'Bash', { command: "cd .claude/agent-memory/reviewer && cat >> MEMORY.md <<'EOF'\n- урок\nEOF" }, true, `${J}: reviewer дописывал agent-memory`, 'reviewer'],
  ['main-agent-memory', 'Write', { file_path: '.claude/agent-memory/x/MEMORY.md', content: 'x' }, true, 'base-rules agent-memory-write (было log)'],
  ['tester-edit-src', 'Edit', { file_path: 'src/a.ts', old_string: '1', new_string: '2' }, true, 'tester.md (только тесты)', 'hub:tester'],
  ['tester-sed-src', 'Bash', { command: "sed -i 's/1/2/' src/a.ts" }, true, 'tester.md (только тесты)', 'hub:tester'],
  ['tester-hub-memory', 'Write', { file_path: '<hub>/projects/demo/memory/errors.md', content: 'x' }, true, 'агенты не пишут память проекта', 'hub:tester'],
  ['explorer-edit', 'Edit', { file_path: 'src/a.ts', old_string: '1', new_string: '2' }, true, 'explorer.md (только чтение)', 'hub:explorer'],
  ['reviewer-diff-tmp', 'Bash', { command: 'git diff main..HEAD > <tmp>/r.diff && git log --oneline -3' }, false, `${J}: дифф в scratchpad`, 'hub:reviewer'],
  ['reviewer-scratch-repo', 'Bash', { command: 'S=<tmp>/det; mkdir -p $S && git init -q -b main $S/r && git -C $S/r -c user.name=t -c user.email=t@t commit -q --allow-empty -m a' }, false, `${J}: проба в своём репозитории`, 'hub:reviewer'],
  ['reviewer-notes-scratch', 'Write', { file_path: '<tmp>/notes.md', content: 'x' }, false, 'заметка вне репозитория', 'hub:reviewer'],
  ['reviewer-narrow-test', 'Bash', { command: 'node --test src/a.test.cjs 2>&1 | tail -5' }, false, 'reviewer.md: узкий прогон', 'hub:reviewer'],
  ['tester-write-test', 'Write', { file_path: 'src/a.test.ts', content: 'x' }, false, 'tester.md', 'hub:tester'],
  ['tester-helper', 'Write', { file_path: 'tests/helpers/db.ts', content: 'x' }, false, 'тестовый помощник', 'hub:tester'],
  ['tester-log-tmp', 'Bash', { command: 'npm test > <tmp>/out.log 2>&1' }, false, 'вывод прогона вне репозитория', 'hub:tester'],
  ['explorer-grep', 'Bash', { command: 'grep -rn "export" src 2>/dev/null | head' }, false, 'чтение', 'hub:explorer'],
  ['main-write-src', 'Write', { file_path: 'src/a.ts', content: 'x' }, false, 'основная сессия пишет код'],
  ['main-hub-memory', 'Write', { file_path: '<hub>/projects/demo/memory/errors.md', content: 'x' }, false, 'основная сессия пишет память (wind-down)'],
  ['general-write-src', 'Write', { file_path: 'src/b.ts', content: 'x' }, false, 'general-purpose — не роль', 'general-purpose'],
];

module.exports = {
  id: 'H20', level: 'hook', mech: 'agent-roles', title: 'agent-roles: роли агентов и память', CORPUS,
  async run(ctx) { return judge('agent-roles', cases(CORPUS, 'H20'), ctx); },
};
