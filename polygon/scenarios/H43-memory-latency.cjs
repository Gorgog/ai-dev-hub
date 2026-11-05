// Приёмочный тест памяти 3 (срез 21): задержка горячего пути при 250 уроках и 7 параллельных сессиях. Один хаб, два
// проекта с одинаковой памятью v2 (250 синтетических уроков с `when`): в одном модули памяти включены (канарейка
// delivery + memory), в другом — только подача; 7 сессий одновременно, каждая гонит вызовы попеременно в оба.
// p95 PreToolUse с памятью против без неё — то, что добавляют модули памяти; порог — +15 мс. Время зависит от
// машины и соседей (pre-commit гоняет две версии разом), поэтому проверка — наблюдение, вне ворот; Evidence среза —
// отдельный прогон в тишине.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');

const SRC = 'acceptance §2 тест 3 [Г]: «250 уроков, 7 параллельных сессий — p95 PreToolUse ≤ базовая + 15 мс»';
const SESSIONS = 7, CALLS = 40;
const lesson = (k) => {
  const when = [`  - tool: ^Bash$`, `    cmd: \\bword${k}\\b[^|;&]*--flag${k % 7}`];
  if (k % 5 === 0) when.push('  - tool: ^(Edit|Write)$', `    path: \\.x${k}$`);
  if (k % 10 === 0) when.push('  - tool: ^(Edit|Write)$', `    body: marker${k}\\(`);
  if (k % 25 === 0) when.push('  - tool: ^Bash$', `    out: failure-${k}:`);
  return ['---', `id: synthetic-${k}`, 'kind: rule', 'when:', ...when, 'keys: []', `status: ${k % 50 === 0 ? 'core' : 'active'}`, 'supersedes: []',
    'source: модель', 'created: 2026-10-01', '---', `Синтетический урок ${k}: первая строка.`, 'Вторая строка.', ''].join('\n');
};
const HEREDOC = ['---', 'id: heredoc-script', 'kind: rule', 'when:', '  - tool: ^Bash$', "    cmd: <<\\s*'?EOF", 'keys: []', 'status: active', 'supersedes: []',
  'source: модель', 'created: 2026-10-01', '---', 'Скрипт — файлом через Write, не heredoc в Bash.', 'Вторая строка.', ''].join('\n');

// One session: CALLS calls, each to both projects in turn (order alternates), Pre then Post; prints the times as JSON.
const WORKER = `
const { spawnSync } = require('child_process');
const st = JSON.parse(process.argv[1]);
const cmds = ['git status --short', "python3 - <<'EOF'\\nprint(1)\\nEOF", 'npm test -- --run src/a.test.ts', 'cat src/index.ts | head -40', 'word7 --flag0 build'];
const t = { mem: { pre: [], post: [] }, off: { pre: [], post: [] } };
const run = (side, event, ev) => {
  const t0 = process.hrtime.bigint();
  spawnSync(process.execPath, [st.runner, event], { input: JSON.stringify(ev), env: { ...process.env, HUB_LOG_DIR: st.data[side] }, encoding: 'utf8' });
  return Number(process.hrtime.bigint() - t0) / 1e6;
};
for (const side of ['mem', 'off']) run(side, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: st.sid + side, cwd: st.cwd[side] });
for (let i = 0; i < st.calls; i++) {
  const order = i % 2 ? ['mem', 'off'] : ['off', 'mem'];
  for (const side of order) {
    const base = { session_id: st.sid + side, cwd: st.cwd[side], permission_mode: 'default', tool_name: 'Bash', tool_use_id: 't' + i, tool_input: { command: cmds[i % cmds.length] } };
    t[side].pre.push(run(side, 'PreToolUse', { ...base, hook_event_name: 'PreToolUse' }));
    t[side].post.push(run(side, 'PostToolUse', { ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: 'ok', stderr: '' } }));
  }
}
process.stdout.write(JSON.stringify(t));
`;

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

module.exports = {
  id: 'H43', level: 'hook', mech: 'memory-hooks', title: 'Задержка: 250 уроков, 7 сессий — p95 PreToolUse с памятью ≤ +15 мс (21)',
  async run({ base, pluginDir, work }) {
    const memory = { 'lessons/heredoc-script.md': HEREDOC };
    for (let k = 0; k < 249; k++) memory[`lessons/synthetic-${k}.md`] = lesson(k);
    const { hub, proj } = makeHub(base, work, { name: 'mem', memory, extra: { 'canary.json': JSON.stringify({ mechanisms: ['delivery', 'memory'] }) } });
    const off = path.join(hub, 'projects', 'off');
    fs.cpSync(proj, off, { recursive: true });
    fs.writeFileSync(path.join(off, 'canary.json'), JSON.stringify({ mechanisms: ['delivery'] }));
    const cwd = { mem: path.join(proj, 'worktrees', 'K-1'), off: path.join(off, 'worktrees', 'K-1') };
    for (const d of Object.values(cwd)) fs.mkdirSync(d, { recursive: true });
    const runner = path.join(pluginDir, 'hooks', 'run.cjs');
    const env = { ...process.env, AI_DEV_HUB: hub };
    delete env.HUB_OFF;
    const outs = await Promise.all(Array.from({ length: SESSIONS }, (_, p) => new Promise((resolve) => {
      const st = { runner, cwd, sid: `eval-h43-${p}-`, calls: CALLS, data: { mem: path.join(work, `data-mem-${p}`), off: path.join(work, `data-off-${p}`) } };
      let buf = '';
      const c = spawn(process.execPath, ['-e', WORKER, JSON.stringify(st)], { env });
      c.stdout.on('data', (d) => { buf += d; });
      c.on('exit', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    })));
    const ok = outs.filter(Boolean);
    const all = (side, ev) => ok.flatMap((o) => o[side][ev]);
    let triggers = 0;
    try { triggers = JSON.parse(fs.readFileSync(path.join(proj, 'memory', '.triggers.json'), 'utf8')).lessons.length; } catch { /* none */ }
    const pre = { mem: q(all('mem', 'pre'), 0.95), off: q(all('off', 'pre'), 0.95) };
    const post = { mem: q(all('mem', 'post'), 0.95), off: q(all('off', 'post'), 0.95) };
    const d = pre.mem - pre.off;
    const fmt = (x) => (x == null ? '—' : x.toFixed(1));
    return [
      { id: 'pre-p95-plus-15', observe: true, source: SRC, pass: ok.length === SESSIONS && triggers === 250 && d <= 15,
        detail: `${ok.length}×${CALLS} вызовов, уроков с триггером ${triggers}; PreToolUse p95 с памятью ${fmt(pre.mem)} мс, без ${fmt(pre.off)} мс (${d >= 0 ? '+' : ''}${fmt(d)}); `
          + `PostToolUse p95 ${fmt(post.mem)} / ${fmt(post.off)} мс` },
    ];
  },
};
