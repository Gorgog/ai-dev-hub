// Другие модули PostToolUse на инструментах, которые матчер пустил в срезе 35 (Agent/Task, MCP браузера, трекера,
// GitLab), молчат, как молчали, когда хук их не видел: вывод тестов (done-gate) — только Bash, проверка записи урока —
// только Write/Edit/MultiEdit, даже если вывод MCP или отчёт агента несёт красную сводку тестов, а вход — путь в
// memory/lessons/. Контроль: те же сводка и запись через Bash и Write модули ловят. Цена — наблюдение (как H43):
// p95 PostToolUse на вызове MCP с выводом 50 КБ с модулями памяти против проекта только с подачей, 3 сессии × 20.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'бриф 35: «остальные модули PostToolUse на новые инструменты не должны менять поведение»';
const PRICE = 'бриф 35: «p95 в пределах H43» (acceptance §2 тест 3: +15 мс к базе; здесь — PostToolUse на MCP, наблюдение)';
const VITEST = ' Test Files  1 failed (1)\n      Tests  2 failed | 3 passed (5)\n';
const blocks = (t) => [{ type: 'text', text: t }];

const WORKER = `
const { spawnSync } = require('child_process');
const st = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const page = 'Строка страницы трекера с кнопками. '.repeat(1400);
const t = { mem: [], off: [] };
for (const side of ['mem', 'off']) spawnSync(process.execPath, [st.runner, 'SessionStart'], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: st.sid + side, cwd: st.cwd[side] }), env: { ...process.env, HUB_LOG_DIR: st.data[side] } });
for (let i = 0; i < st.calls; i++) for (const side of i % 2 ? ['mem', 'off'] : ['off', 'mem']) {
  const ev = { hook_event_name: 'PostToolUse', session_id: st.sid + side, cwd: st.cwd[side], permission_mode: 'default', tool_use_id: 't' + i,
    tool_name: 'mcp__claude-in-chrome__get_page_text', tool_input: { tabId: 1 }, tool_response: [{ type: 'text', text: page }] };
  const t0 = process.hrtime.bigint();
  spawnSync(process.execPath, [st.runner, 'PostToolUse'], { input: JSON.stringify(ev), env: { ...process.env, HUB_LOG_DIR: st.data[side] }, encoding: 'utf8' });
  t[side].push(Number(process.hrtime.bigint() - t0) / 1e6);
}
process.stdout.write(JSON.stringify(t));
`;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

module.exports = {
  id: 'H60', level: 'hook', mech: 'memory-hooks', title: 'PostToolUse на новых инструментах: другие модули молчат, цена — наблюдение (35)',
  async run({ base, pluginDir, work }) {
    const canary = JSON.stringify({ mechanisms: ['delivery', 'memory', 'done-gate'] });
    const { hub, proj } = makeHub(base, work, { name: 'mem', memory: { 'lessons/bad.md': 'не урок\n' }, extra: { 'canary.json': canary } });
    const mem = path.join(proj, 'memory');
    const cwd = path.join(proj, 'worktrees', 'K-1');
    fs.mkdirSync(cwd, { recursive: true });
    const env = { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, 'data') };
    let n = 0;
    const post = (tool_name, tool_input, tool_response) => {
      const res = runEvent(pluginDir, 'PostToolUse', { hook_event_name: 'PostToolUse', session_id: 'eval-h60', permission_mode: 'default', cwd,
        tool_name, tool_use_id: `t${++n}`, tool_input, tool_response }, env);
      const json = res.map((r) => r.json).find(Boolean) || {};
      return { ran: res.length > 0, text: `${(json.hookSpecificOutput || {}).additionalContext || ''}${json.decision === 'block' ? json.reason : ''}` };
    };
    runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'eval-h60', cwd }, env);
    const bad = path.join(mem, 'lessons', 'bad.md');
    const newTools = [
      post('Agent', { description: 'tests', prompt: 'прогони тесты', subagent_type: 'x' }, { status: 'completed', content: blocks(`Прогнал:\n${VITEST}`) }),
      post('mcp__claude-in-chrome__get_page_text', { tabId: 1 }, blocks(`CI:\n${VITEST}`)),
      post('mcp__plugin_studio-skills_gitlab__gitlab_note', { body: 'x', file_path: bad }, blocks(VITEST)),
      post('mcp__Claude_Browser__javascript_tool', { text: 'x', file_path: bad }, { content: blocks(VITEST) }),
      post('mcp__plugin_studio-skills_tracker__tracker_issue', { key: 'K-1', file_path: bad }, VITEST),
    ];
    const loud = newTools.filter((r) => /Вывод тестов не зелёный|урок|Хаб:/i.test(r.text));
    // Control: the same summary through Bash and the same bad lesson through Write — the modules catch them.
    const ctlBash = post('Bash', { command: 'npx vitest run' }, { stdout: VITEST, stderr: '' });
    const ctlWrite = post('Write', { file_path: bad, content: 'не урок' }, { type: 'update', filePath: bad });

    // Price: 3 sessions × 20 calls, the same project with the delivery only as the base.
    const off = path.join(hub, 'projects', 'off');
    fs.cpSync(proj, off, { recursive: true });
    fs.writeFileSync(path.join(off, 'canary.json'), JSON.stringify({ mechanisms: ['delivery'] }));
    fs.rmSync(path.join(mem, 'lessons', 'bad.md'), { force: true });
    fs.rmSync(path.join(off, 'memory', 'lessons', 'bad.md'), { force: true });
    const cw = { mem: cwd, off: path.join(off, 'worktrees', 'K-1') };
    const runner = path.join(pluginDir, 'hooks', 'run.cjs');
    const penv = { ...process.env, AI_DEV_HUB: hub };
    delete penv.HUB_OFF;
    const outs = await Promise.all([0, 1, 2].map((p) => new Promise((resolve) => {
      const sf = path.join(work, `st-${p}.json`);
      fs.writeFileSync(sf, JSON.stringify({ runner, cwd: cw, sid: `eval-h60-${p}-`, calls: 20, data: { mem: path.join(work, `pm-${p}`), off: path.join(work, `po-${p}`) } }));
      let buf = '';
      const c = spawn(process.execPath, ['-e', WORKER, sf], { env: penv });
      c.stdout.on('data', (d) => { buf += d; });
      c.on('exit', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    })));
    const ok = outs.filter(Boolean);
    const pm = q(ok.flatMap((o) => o.mem), 0.95), po = q(ok.flatMap((o) => o.off), 0.95);
    const d = pm - po;
    const fmt = (x) => (x == null ? '—' : x.toFixed(1));
    return [
      { id: 'new-tools-quiet', kind: 'quiet', source: SRC, pass: newTools.every((r) => r.ran) && !loud.length,
        detail: `${newTools.filter((r) => r.ran).length}/${newTools.length} вызовов дошли до хука; заговорили: ${loud.map((r) => r.text.slice(0, 80)).join(' | ') || 'никто'}` },
      { id: 'control-bash-write', source: SRC, pass: /Вывод тестов не зелёный/.test(ctlBash.text) && ctlWrite.text.length > 0,
        detail: `контроль: Bash «${ctlBash.text.slice(0, 60)}», Write «${ctlWrite.text.slice(0, 60)}»` },
      { id: 'mcp-post-p95', observe: true, source: PRICE, pass: ok.length === 3 && d <= 15,
        detail: `${ok.length}×20 вызовов get_page_text (50 КБ): p95 с памятью ${fmt(pm)} мс, без ${fmt(po)} мс (${d >= 0 ? '+' : ''}${fmt(d)})` },
    ];
  },
};
