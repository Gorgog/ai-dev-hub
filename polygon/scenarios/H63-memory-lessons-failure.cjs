// Уроки на упавших вызовах (срез 37, решение 06.11 — отдельный срез после 35): упавший вызов — событие
// PostToolUseFailure; модуль уроков там видит текст ошибки (поле `error`: текст tool_result, проба P37 на Claude Code
// 2.1.317) — урок про таймаут браузера, «команды нет», не найденный тип агента приходит сразу после ошибки. Матчер —
// как у PostToolUse: служебные MCP и инструменты, которые держат имя из списка внутри своего (TodoWrite), хук не видит.
// Урок второй раз в эпохе не подаётся — и через событие: поданный после удачного вызова на ошибке молчит. Цена —
// наблюдение (как H43, H60): p95 PostToolUseFailure с модулями памяти против проекта только с подачей, 3 сессии × 20.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'решение 06.11: «модуль уроков на PostToolUseFailure — отдельным срезом после 35» (бриф 37 п. 1; уроки таймаутов браузера живут только на ошибках, замер 35)';
const QUIET = 'бриф 37 п. 1: «матчер PostToolUseFailure — с якорями, тот же список, что у PostToolUse»';
const PRICE = 'бриф 37: «p95 в пределах H43» (acceptance §2 тест 3: +15 мс к базе; здесь — PostToolUseFailure, наблюдение)';
const lesson = (id, when, first) => ['---', `id: ${id}`, 'kind: rule', 'when:', ...when, 'keys: []', 'status: active', 'supersedes: []',
  'source: модель', 'created: 2026-10-01', '---', first, 'Вторая строка урока.', ''].join('\n');
const MEMORY = {
  'lessons/tab-timeout.md': lesson('tab-timeout', ['  - tool: ^mcp__(claude-in-chrome|Claude_Browser)__', '    out: timed out|timeout'],
    'Таймаут браузера на фоновой вкладке — выведи вкладку вперёд, не повторяй вызов вслепую.'),
  'lessons/exit-127.md': lesson('exit-127', ['  - tool: ^Bash$', '    out: command not found'], 'Команды нет в PATH — проверь окружение раннера.'),
  'lessons/agent-type.md': lesson('agent-type', ['  - tool: ^(Agent|Task)$', '    out: Agent type .* not found'], 'Тип агента — с префиксом плагина.'),
  'lessons/any-mark.md': lesson('any-mark', ['  - out: FAIL_MARKER'], 'Маркер в ошибке.'),
};

const WORKER = `
const { spawnSync } = require('child_process');
const st = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const err = 'MCP server "claude-in-chrome" tool "get_page_text" failed: ' + 'Строка ошибки со стеком вызова. '.repeat(160);
const t = { mem: [], off: [] };
for (const side of ['mem', 'off']) spawnSync(process.execPath, [st.runner, 'SessionStart'], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: st.sid + side, cwd: st.cwd[side] }), env: { ...process.env, HUB_LOG_DIR: st.data[side] } });
for (let i = 0; i < st.calls; i++) for (const side of i % 2 ? ['mem', 'off'] : ['off', 'mem']) {
  const ev = { hook_event_name: 'PostToolUseFailure', session_id: st.sid + side, cwd: st.cwd[side], permission_mode: 'default', tool_use_id: 't' + i,
    tool_name: 'mcp__claude-in-chrome__get_page_text', tool_input: { tabId: 1 }, error: err, is_interrupt: false, duration_ms: 30000 };
  const t0 = process.hrtime.bigint();
  spawnSync(process.execPath, [st.runner, 'PostToolUseFailure'], { input: JSON.stringify(ev), env: { ...process.env, HUB_LOG_DIR: st.data[side] }, encoding: 'utf8' });
  t[side].push(Number(process.hrtime.bigint() - t0) / 1e6);
}
process.stdout.write(JSON.stringify(t));
`;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };

module.exports = {
  id: 'H63', level: 'hook', mech: 'memory-hooks', title: 'Уроки на упавших вызовах: PostToolUseFailure, out — текст ошибки (37)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work, { memory: MEMORY, extra: { 'canary.json': JSON.stringify({ mechanisms: ['delivery', 'memory'] }) } });
    const cwd = path.join(proj, 'worktrees', 'K-1');
    fs.mkdirSync(cwd, { recursive: true });
    const env = { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, 'data') };
    let n = 0;
    const said = (res) => res.map((r) => (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : '')).join('');
    const call = (event, tool_name, tool_input, extra) => {
      const res = runEvent(pluginDir, event, { hook_event_name: event, session_id: 'eval-h63', permission_mode: 'default', cwd, tool_name,
        tool_use_id: `t${++n}`, tool_input, ...extra }, env);
      return { ran: res.length > 0, ctx: said(res) };
    };
    const fail = (tool_name, tool_input, error) => call('PostToolUseFailure', tool_name, tool_input, { error, is_interrupt: false, duration_ms: 5 });
    runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'eval-h63', cwd }, env);
    const tab = fail('mcp__claude-in-chrome__computer', { action: 'screenshot' }, 'MCP server "claude-in-chrome" tool "computer" timed out after 30s');
    const bash = fail('Bash', { command: 'pnpm test' }, 'Exit code 127\nbash: pnpm: command not found');
    const agent = fail('Agent', { subagent_type: 'reviewer', prompt: 'x' }, "Agent type 'reviewer' not found. Available agents: hub:reviewer");
    const other = fail('Bash', { command: 'npm test' }, 'Exit code 1\nassertion failed');
    const tab2 = fail('mcp__Claude_Browser__navigate', { url: 'x' }, 'Navigation timeout after 30000ms');
    // once per epoch across the events: a lesson delivered after a finished call keeps quiet on a failed one
    const okMark = call('PostToolUse', 'Bash', { command: 'make' }, { tool_response: { stdout: 'FAIL_MARKER', stderr: '' } });
    const failMark = fail('Bash', { command: 'make' }, 'Exit code 2\nFAIL_MARKER');
    const service = fail('mcp__ccd_turn__update_plan', { items: [] }, 'FAIL_MARKER');
    const todo = fail('TodoWrite', { todos: [] }, 'FAIL_MARKER');
    const has = (r, id) => new RegExp(`Урок памяти \\(${id}\\)`).test(r.ctx);

    // Price: 3 sessions × 20 failed calls, the same project with the delivery only as the base.
    const off = path.join(hub, 'projects', 'off');
    fs.cpSync(proj, off, { recursive: true });
    fs.writeFileSync(path.join(off, 'canary.json'), JSON.stringify({ mechanisms: ['delivery'] }));
    const cw = { mem: cwd, off: path.join(off, 'worktrees', 'K-1') };
    const runner = path.join(pluginDir, 'hooks', 'run.cjs');
    const penv = { ...process.env, AI_DEV_HUB: hub };
    delete penv.HUB_OFF;
    const outs = await Promise.all([0, 1, 2].map((p) => new Promise((resolve) => {
      const sf = path.join(work, `st-${p}.json`);
      fs.writeFileSync(sf, JSON.stringify({ runner, cwd: cw, sid: `eval-h63-${p}-`, calls: 20, data: { mem: path.join(work, `pm-${p}`), off: path.join(work, `po-${p}`) } }));
      let buf = '';
      const c = spawn(process.execPath, ['-e', WORKER, sf], { env: penv });
      c.stdout.on('data', (d) => { buf += d; });
      c.on('exit', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    })));
    const ok = outs.filter(Boolean);
    const pm = q(ok.flatMap((o) => o.mem), 0.95), po = q(ok.flatMap((o) => o.off), 0.95);
    const d = pm == null || po == null ? null : pm - po;
    const fmt = (x) => (x == null ? '—' : x.toFixed(1));
    const show = (r) => (r.ran ? r.ctx.slice(0, 110) || 'пусто' : 'хук не вызван');
    return [
      { id: 'browser-timeout', source: SRC, pass: tab.ran && has(tab, 'tab-timeout') && /\[Данные из памяти хаба/.test(tab.ctx), detail: `computer: ${show(tab)}` },
      { id: 'bash-error', source: SRC, pass: bash.ran && has(bash, 'exit-127'), detail: `Bash: ${show(bash)}` },
      { id: 'agent-error', source: SRC, pass: agent.ran && has(agent, 'agent-type'), detail: `Agent: ${show(agent)}` },
      { id: 'other-error-quiet', kind: 'quiet', source: SRC, pass: other.ran && !/Урок памяти/.test(other.ctx), detail: `Bash без признака: ${show(other)}` },
      { id: 'once-per-epoch', kind: 'quiet', source: SRC, pass: tab2.ran && !has(tab2, 'tab-timeout'), detail: `второй таймаут в эпохе: ${show(tab2)}` },
      { id: 'once-across-events', kind: 'quiet', source: SRC, pass: has(okMark, 'any-mark') && failMark.ran && !has(failMark, 'any-mark'),
        detail: `после удачного: ${show(okMark).slice(0, 50)}; после ошибки: ${show(failMark)}` },
      { id: 'matcher-tight', kind: 'quiet', source: QUIET, pass: !service.ran && !todo.ran,
        detail: `ccd_turn ${service.ran ? 'вызван' : 'не вызван'}, TodoWrite ${todo.ran ? 'вызван' : 'не вызван'}` },
      { id: 'failure-p95', observe: true, source: PRICE, pass: ok.length === 3 && d != null && d <= 15,
        detail: `${ok.length}×20 упавших get_page_text (ошибка 5 КБ): p95 с памятью ${fmt(pm)} мс, без ${fmt(po)} мс (${d != null && d >= 0 ? '+' : ''}${fmt(d)})` },
    ];
  },
};
