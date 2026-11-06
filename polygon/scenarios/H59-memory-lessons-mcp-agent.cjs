// Уроки после вызовов MCP и Agent (срез 35, решение 06.11 — вариант А): матчер PostToolUse из hooks.json пускает
// Agent/Task и MCP браузера, трекера и GitLab — урок с `when` на такой вызов приходит сразу после него, в том числе по
// выводу (блоки text результата MCP, отчёт агента — handbackReport у сдавшего через SubagentHandback). Тишина: служебные MCP приложения (ccd_*) хук
// не видит; упавший вызов тех же инструментов виден и учит по тексту ошибки (срез 37, H63); урок второй раз в эпохе не подаётся. Вызовы идут через матчер, как их пускает Claude Code.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'решение 06.11 по 35 (вариант А): «матчер PostToolUse — Agent|Task|браузер|трекер|GitLab; out — блоки content у MCP/Agent»';
const QUIET = 'решение 06.11 по 35: служебные MCP — только цена, уроков на них нет (замер 35)';
const FAIL37 = 'решение 06.11 о срезе 37: модуль уроков на PostToolUseFailure, матчер — как у PostToolUse (подробно — H63)';
const lesson = (id, when, first) => ['---', `id: ${id}`, 'kind: rule', 'when:', ...when, 'keys: []', 'status: active', 'supersedes: []',
  'source: модель', 'created: 2026-10-01', '---', first, 'Вторая строка урока.', ''].join('\n');
const MEMORY = {
  'lessons/page-task.md': lesson('page-task', ['  - tool: ^mcp__(claude-in-chrome|Claude_Browser)__get_page_text$', '    out: \\bK-\\d{3}\\b'], 'Задачу трекера — скриншотом, не текстом страницы.'),
  'lessons/agent-report.md': lesson('agent-report', ['  - tool: ^(Agent|Task)$', '    out: ERR_CONNECTION_RESET'], 'Сброс соединения в отчёте агента — память фронта, не регресс.'),
  'lessons/tracker-whole.md': lesson('tracker-whole', ['  - tool: tracker_issue$'], 'Задачу — целиком, с комментариями и связями.'),
  'lessons/mr-branch.md': lesson('mr-branch', ['  - tool: gitlab_mr_create$'], 'MR — сверь исходную ветку.'),
  'lessons/any-reset.md': lesson('any-reset', ['  - out: SERVICE_MARKER'], 'Маркер в выводе.'),
};

const said = (res) => res.map((r) => (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : '')).join('');
const blocks = (t) => [{ type: 'text', text: t }];

module.exports = {
  id: 'H59', level: 'hook', mech: 'memory-hooks', title: 'Уроки после MCP и Agent: матчер PostToolUse и out из content (35)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work, { memory: MEMORY, extra: { 'canary.json': JSON.stringify({ mechanisms: ['delivery', 'memory'] }) } });
    const cwd = path.join(proj, 'worktrees', 'K-1');
    fs.mkdirSync(cwd, { recursive: true });
    const env = { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, 'data') };
    let n = 0;
    const ev = (event, extra) => runEvent(pluginDir, event, { hook_event_name: event, session_id: 'eval-h59', permission_mode: 'default', cwd, ...extra }, env);
    const post = (tool_name, tool_input, tool_response, event = 'PostToolUse') => {
      const res = ev(event, { tool_name, tool_use_id: `t${++n}`, tool_input, tool_response });
      return { ran: res.length > 0, ctx: said(res) };
    };
    ev('SessionStart', { source: 'startup' });
    const page = post('mcp__claude-in-chrome__get_page_text', { tabId: 1 }, blocks('Трекер: K-123 «Починить вход»'));
    const page2 = post('mcp__Claude_Browser__get_page_text', { tabId: 2 }, blocks('Трекер: K-456'));
    // A hub agent hands its report back (SubagentHandback): content is a stub, the report — handbackReport.text.
    const agent = post('Agent', { description: 'qa', prompt: 'проверь стенд', subagent_type: 'x' }, { status: 'completed', handback: 'send',
      handbackReport: { text: 'Стенд отдал ERR_CONNECTION_RESET дважды' }, content: blocks('This agent\'s report was delivered to you as a message.') });
    const tracker = post('mcp__plugin_studio-skills_tracker__tracker_issue', { key: 'K-1' }, blocks('{"summary":"x"}'));
    const gitlab = post('mcp__plugin_studio-skills_gitlab__gitlab_mr_create', { title: 't' }, blocks('created'));
    const service = post('mcp__ccd_turn__update_plan', { items: [] }, blocks('SERVICE_MARKER'));
    // A failed call carries its text in `error`, not in tool_response (probe P37, slice 37).
    const fail = (tool_name, tool_input, error) => {
      const res = ev('PostToolUseFailure', { tool_name, tool_use_id: `t${++n}`, tool_input, error, is_interrupt: false });
      return { ran: res.length > 0, ctx: said(res) };
    };
    const failure = fail('mcp__claude-in-chrome__computer', { action: 'left_click' }, 'SERVICE_MARKER timeout');
    const failBash = fail('Bash', { command: 'false' }, 'Exit code 1\nSERVICE_MARKER');

    // Claude Code tests a matcher with anything but names and `|` as a regex WITHOUT anchors (probe P35, 2.1.317):
    // the matcher must not let in a tool whose name holds one of its names.
    const m = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), 'utf8')).hooks.PostToolUse[0].matcher;
    const asCC = (t) => (/^[A-Za-z0-9_|]+$/.test(m) ? m.split('|').includes(t) : new RegExp(m).test(t));
    const leak = ['TodoWrite', 'TaskList', 'TaskStop', 'BashOutput', 'ListAgents', 'mcp__x__EditFile'].filter(asCC);
    const has = (r, id) => new RegExp(`Урок памяти \\(${id}\\)`).test(r.ctx);
    return [
      { id: 'browser-out', source: SRC, pass: page.ran && has(page, 'page-task') && /\[Данные из памяти хаба/.test(page.ctx), detail: `get_page_text: ${page.ran ? page.ctx.slice(0, 120) || 'пусто' : 'хук не вызван'}` },
      { id: 'agent-report', source: SRC, pass: agent.ran && has(agent, 'agent-report'), detail: `Agent: ${agent.ran ? agent.ctx.slice(0, 120) || 'пусто' : 'хук не вызван'}` },
      { id: 'tracker', source: SRC, pass: tracker.ran && has(tracker, 'tracker-whole'), detail: `трекер: ${tracker.ran ? tracker.ctx.slice(0, 120) || 'пусто' : 'хук не вызван'}` },
      { id: 'gitlab', source: SRC, pass: gitlab.ran && has(gitlab, 'mr-branch'), detail: `GitLab: ${gitlab.ran ? gitlab.ctx.slice(0, 120) || 'пусто' : 'хук не вызван'}` },
      { id: 'once-per-epoch', kind: 'quiet', source: SRC, pass: page2.ran && !has(page2, 'page-task'), detail: `второй раз в эпохе: ${page2.ctx.slice(0, 100) || (page2.ran ? 'пусто' : 'хук не вызван')}` },
      { id: 'service-mcp-unseen', kind: 'quiet', source: QUIET, pass: !service.ran, detail: `ccd_turn: ${service.ran ? `хук вызван: ${service.ctx.slice(0, 80)}` : 'не вызван'}` },
      { id: 'matcher-unanchored-tight', kind: 'quiet', source: QUIET, pass: !leak.length && ['Agent', 'Bash', 'mcp__claude-in-chrome__computer'].every(asCC),
        detail: `матчер как его проверяет Claude Code (регэксп без якорей): лишние ${leak.join(', ') || 'нет'}` },
      // Slice 37 (decision 06.11) changed what this check held: a failed MCP call now reaches the lesson module (H63 owns
      // the details); here — only that the failure path of the same tools is seen and teaches by the error text.
      { id: 'failure-now-seen', source: FAIL37, pass: failure.ran && failBash.ran && /Урок памяти \(any-reset\)/.test(failure.ctx + failBash.ctx),
        detail: `PostToolUseFailure: MCP ${failure.ran ? 'вызван' : 'не вызван'}, Bash ${failBash.ran ? 'вызван' : 'не вызван'}; ${(failure.ctx + failBash.ctx).slice(0, 80) || 'урока нет'}` },
    ];
  },
};
