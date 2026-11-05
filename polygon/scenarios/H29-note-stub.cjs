// Конец сессии без wind-down оставляет заглушку заметки (правило 9): SessionEnd пишет её сам; не дошёл — следующий
// SessionStart той же папки, с напоминанием. Сессия с заметкой wind-down и сессия без работы — без заглушки. Срез 16.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

// A synthetic transcript: one user message, then tool calls (the first `edits` of them Edit).
function transcript(dir, sid, cwd, { tools = 3, edits = 1, start, branch = 'DEMO-5' }) {
  const base = { sessionId: sid, cwd, gitBranch: branch };
  const lines = [{ ...base, type: 'user', timestamp: new Date(start).toISOString(), message: { role: 'user', content: 'сделай DEMO-5' } }];
  for (let i = 0; i < tools; i++) lines.push({ ...base, type: 'assistant', timestamp: new Date(start + (i + 1) * 1000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: i < edits ? 'Edit' : 'Bash', input: {} }] } });
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

module.exports = {
  id: 'H29', level: 'hook', mech: 'done-gate', title: 'Заглушка заметки при конце сессии без wind-down',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work, { extra: { 'canary.json': JSON.stringify({ mechanisms: ['done-gate'] }) } });
    const wt = path.join(proj, 'worktrees', 'DEMO-5');
    fs.mkdirSync(wt, { recursive: true });
    const sessions = path.join(proj, 'memory', 'sessions');
    const stubs = () => fs.readdirSync(sessions).filter((f) => /-stub-/.test(f));
    const env = { AI_DEV_HUB: hub };
    const hour = 3600_000;
    const checks = [];
    const src = 'P7 (04): SessionEnd при /exit, Ctrl+C, обрыве и архивировании; правило 9 хаба';

    // 1. SessionEnd of a session with work and no note.
    const t1 = path.join(work, 'tr1'); fs.mkdirSync(t1);
    const a = transcript(t1, 'a0000001-end', wt, { start: Date.now() - hour });
    runEvent(pluginDir, 'SessionEnd', { hook_event_name: 'SessionEnd', session_id: 'a0000001-end', transcript_path: a, cwd: wt, reason: 'other' }, env);
    const s1 = stubs().filter((f) => /a0000001/.test(f));
    checks.push({ id: 'end-writes-stub', source: src, pass: s1.length === 1 && /## Дальше/.test(fs.readFileSync(path.join(sessions, s1[0] || 'x'), 'utf8')),
      detail: `заглушек ${s1.length}: ${s1.join(', ')}` });

    // 2. wind-down wrote the note — no stub.
    const b = transcript(t1, 'b0000002-done', wt, { start: Date.now() - hour });
    fs.writeFileSync(path.join(sessions, '2026-11-05-DEMO-5-feature.md'), '# DEMO-5\n\n## Дальше\n- ревью\n');
    runEvent(pluginDir, 'SessionEnd', { hook_event_name: 'SessionEnd', session_id: 'b0000002-done', transcript_path: b, cwd: wt, reason: 'prompt_input_exit' }, env);
    checks.push({ id: 'note-no-stub', kind: 'quiet', source: src, pass: !stubs().some((f) => /b0000002/.test(f)), detail: stubs().join(', ') });

    // 3. A session without work — no stub.
    const c = transcript(t1, 'c0000003-idle', wt, { tools: 2, edits: 0, start: Date.now() + 1000 });
    runEvent(pluginDir, 'SessionEnd', { hook_event_name: 'SessionEnd', session_id: 'c0000003-idle', transcript_path: c, cwd: wt, reason: 'other' }, env);
    checks.push({ id: 'idle-no-stub', kind: 'quiet', source: src, pass: !stubs().some((f) => /c0000003/.test(f)), detail: stubs().join(', ') });

    // 4. SessionEnd never came: the next SessionStart of the folder writes the stub and reminds.
    const wt2 = path.join(proj, 'worktrees', 'DEMO-6');
    fs.mkdirSync(wt2, { recursive: true });
    const t2 = path.join(work, 'tr2'); fs.mkdirSync(t2);
    const prev = transcript(t2, 'd0000004-lost', wt2, { branch: 'DEMO-6', start: Date.now() - 2 * hour });
    const old = (Date.now() - hour) / 1000;
    fs.utimesSync(prev, old, old);
    const cur = transcript(t2, 'e0000005-next', wt2, { branch: 'DEMO-6', tools: 0, edits: 0, start: Date.now() });
    const r = runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'e0000005-next', transcript_path: cur, cwd: wt2 }, env);
    const out = r.map((x) => x.stdout).join('\n');
    const s4 = stubs().filter((f) => /d0000004/.test(f));
    checks.push({ id: 'start-writes-stub', source: src, pass: s4.length === 1 && /wind-down/.test(out),
      detail: `заглушек ${s4.length}; напоминание: ${/wind-down/.test(out) ? 'есть' : 'нет'}` });
    return checks;
  },
};
