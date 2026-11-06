// Матчер PreToolUse с якорями (срез 37): Claude Code проверяет матчер с символами вне имён и `|` как регэксп без
// якорей (пробы P35, P37 на 2.1.317) — прежний матчер `…|Task|mcp__…__.*` пускал в pretool.d TaskList, TaskCreate,
// TaskStop, TodoWrite, BashOutput, ListAgents. Теперь — только инструменты из списка, по имени; они доходят, как
// доходили, и правила (замок, rules-guard) на них работают. Вызовы идут через матчер, как их пускает Claude Code
// (polygon/lib/hooks.cjs).
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'бриф 37 п. 2: «матчер PreToolUse без якорей пускает TodoWrite, TaskCreate, TaskStop, BashOutput, ListAgents — заякорить ^(?:…)$»';
const KEEP = 'бриф 37 п. 2: «проверь, как модули pretool.d сравнивают tool_name (не изменится ли их поведение)»';
const LEAKED = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'BashOutput', 'KillBash', 'ListAgents',
  'mcp__x__EditFile', 'xmcp__claude-in-chrome__computer'];
const NAMED = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'mcp__Claude_Browser__navigate', 'mcp__claude-in-chrome__computer'];

module.exports = {
  id: 'H64', level: 'hook', mech: 'rules-guard', title: 'Матчер PreToolUse с якорями: только инструменты из списка (37)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work, {});
    const cwd = path.join(proj, 'worktrees', 'K-1');
    fs.mkdirSync(cwd, { recursive: true });
    const env = { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, 'data') };
    let n = 0;
    const pre = (tool_name, tool_input = {}) => runEvent(pluginDir, 'PreToolUse', { hook_event_name: 'PreToolUse', session_id: 'eval-h64',
      permission_mode: 'default', cwd, tool_name, tool_use_id: `t${++n}`, tool_input }, env);
    const leaked = LEAKED.filter((t) => pre(t, { todos: [], task_id: 'x' }).length > 0);
    const missed = NAMED.filter((t) => pre(t, { command: 'echo ok', file_path: path.join(cwd, 'a.txt') }).length === 0);
    // A rule still bites a named tool: a bare push through Bash is stopped as before.
    const push = pre('Bash', { command: 'git push' });
    const stopped = push.some((r) => r.code === 2 || (r.json && r.json.hookSpecificOutput && ['deny', 'ask'].includes(r.json.hookSpecificOutput.permissionDecision)));
    return [
      { id: 'no-leak', kind: 'quiet', source: SRC, pass: !leaked.length, detail: `дошли до PreToolUse лишние: ${leaked.join(', ') || 'нет'}` },
      { id: 'named-reach', source: KEEP, pass: !missed.length, detail: `не дошли из списка: ${missed.join(', ') || 'нет'}` },
      { id: 'rules-still-bite', source: KEEP, pass: stopped, detail: `git push через Bash: ${stopped ? 'остановлен' : 'прошёл'}` },
    ];
  },
};
