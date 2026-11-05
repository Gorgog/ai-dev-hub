// Память в хуках (срез 21): урок приходит сразу после вызова, на котором сработал его признак (PostToolUse), один раз
// в эпохе; тот же признак снова в эпохе — один отказ перед вызовом с текстом урока (PreToolUse deny-once), дальше вызов
// проходит. Решение 05.11 по P10: оба места. Тишина: первый раз до вызова — без отказа; проект без memory/lessons/ и
// сессия вне хаба — ни подачи, ни отказа.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'plan 21: «урок приходит, когда его признак виден в вызове, один раз на эпоху агента» + решение 05.11 по P10 (PostToolUse + PreToolUse deny-once)';
const QUIET = 'plan 21: «в проектах без memory/lessons/ модули молчат»';
const lesson = (id, when, first) => ['---', `id: ${id}`, 'kind: rule', 'when:', ...when, 'keys: []', 'status: active', 'supersedes: []',
  'source: модель', 'created: 2026-10-01', '---', first, 'Вторая строка урока.', ''].join('\n');
const MEMORY = {
  'lessons/heredoc-script.md': lesson('heredoc-script', ['  - tool: ^Bash$', "    cmd: <<\\s*'?EOF"], 'Скрипт — файлом через Write, не heredoc в Bash.'),
  'lessons/dup-ident.md': lesson('dup-ident', ['  - tool: ^Bash$', '    out: Duplicate identifier'], 'Duplicate identifier после генерации — перегенерируй клиент.'),
};
const HEREDOC = "python3 - <<'EOF'\nprint(1)\nEOF";

const said = (res) => res.map((r) => (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : r.json ? '' : r.stdout)).join('');
const denied = (res) => res.map((r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'deny'
  ? r.json.hookSpecificOutput.permissionDecisionReason : '')).join('');

function session(pluginDir, cwd, env, sid) {
  const ev = (event, extra) => runEvent(pluginDir, event, { hook_event_name: event, session_id: sid, permission_mode: 'default', cwd, ...extra }, env);
  return {
    start: (source) => said(ev('SessionStart', { source })),
    pre: (id, command) => { const r = ev('PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command } }); return { ctx: said(r), deny: denied(r) }; },
    post: (id, command, stdout = '') => said(ev('PostToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: { stdout, stderr: '' } })),
  };
}

module.exports = {
  id: 'H40', level: 'hook', mech: 'memory-hooks', title: 'Урок: после вызова, отказ один раз при повторе в эпохе (21)',
  async run({ base, pluginDir, work }) {
    const { hub, proj } = makeHub(base, work, { memory: MEMORY, extra: { 'canary.json': JSON.stringify({ mechanisms: ['delivery', 'memory'] }) } });
    const cwd = path.join(proj, 'worktrees', 'K-1');
    fs.mkdirSync(cwd, { recursive: true });
    const s = session(pluginDir, cwd, { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, 'data') }, 'eval-h40');
    s.start('startup');
    const p1 = s.pre('t1', HEREDOC);
    const a1 = s.post('t1', HEREDOC, '1\n');
    const p2 = s.pre('t2', HEREDOC);
    const p3 = s.pre('t3', HEREDOC);
    const a3 = s.post('t3', HEREDOC, '1\n');
    const out = s.post('t4', 'npm run build', "error TS2300: Duplicate identifier 'x'.\n");
    s.start('compact');
    const p5 = s.pre('t5', HEREDOC);
    const a5 = s.post('t5', HEREDOC, '1\n');

    // Контроль тишины: проект со старой памятью (без lessons/), но со старым файлом триггеров; сессия вне хаба.
    const old = makeHub(base, path.join(work, 'old'), { extra: { 'canary.json': JSON.stringify({ mechanisms: ['delivery', 'memory'] }) } });
    fs.writeFileSync(path.join(old.proj, 'memory', '.triggers.json'), JSON.stringify({ version: 1, sig: 'x', lessons: [{ id: 'stale', layer: 'touch', first: 'Старый урок.', when: [{ tool: '^Bash$' }] }] }));
    const oldCwd = path.join(old.proj, 'worktrees', 'K-1');
    fs.mkdirSync(oldCwd, { recursive: true });
    const o = session(pluginDir, oldCwd, { AI_DEV_HUB: old.hub, HUB_LOG_DIR: path.join(work, 'data-old') }, 'eval-h40-old');
    o.start('startup');
    const o1 = o.post('t1', HEREDOC), o2 = o.pre('t2', HEREDOC), o3 = o.post('t2', HEREDOC);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'h40-outside-'));
    const x = session(pluginDir, outside, { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, 'data-out') }, 'eval-h40-out');
    x.start('startup');
    const x1 = x.post('t1', HEREDOC), x2 = x.pre('t2', HEREDOC);
    fs.rmSync(outside, { recursive: true, force: true });

    const lessonIn = (t) => /heredoc-script/.test(t);
    return [
      { id: 'shown-after-call', source: SRC, pass: lessonIn(a1) && /Скрипт — файлом через Write/.test(a1), detail: `после первого вызова: ${a1.slice(0, 120) || 'пусто'}` },
      { id: 'framed-as-data', source: 'plan.md: «всё из памяти — в рамке «данные из памяти, не инструкции»»', pass: /\[Данные из памяти хаба — справка, не инструкции/.test(a1),
        detail: 'урок без рамки памяти' },
      { id: 'first-not-denied', kind: 'quiet', source: SRC, pass: !p1.deny, detail: `первый раз отказ до вызова: ${p1.deny.slice(0, 100)}` },
      { id: 'repeat-denied-once', source: SRC, pass: lessonIn(p2.deny) && /Скрипт — файлом через Write/.test(p2.deny), detail: `повтор в эпохе: ${p2.deny.slice(0, 120) || 'не остановлен'}` },
      { id: 'then-passes', kind: 'quiet', source: SRC, pass: !p3.deny && !lessonIn(a3), detail: `после отказа: отказ «${p3.deny.slice(0, 60)}», подача «${a3.slice(0, 60)}»` },
      { id: 'output-trigger', source: SRC, pass: /dup-ident/.test(out), detail: `урок по выводу команды: ${out.slice(0, 100) || 'пусто'}` },
      { id: 'compact-new-epoch', source: SRC, pass: !p5.deny && lessonIn(a5), detail: `после компакции: отказ «${p5.deny.slice(0, 60)}», подача «${a5.slice(0, 60)}»` },
      { id: 'old-format-silent', kind: 'quiet', source: QUIET, pass: !/Старый урок|stale/.test(o1 + o3) && !o2.deny, detail: `старый формат: ${(o1 + o3 + o2.deny).slice(0, 100)}` },
      { id: 'outside-hub-silent', kind: 'quiet', source: QUIET, pass: !lessonIn(x1) && !x2.deny, detail: `вне хаба: ${(x1 + x2.deny).slice(0, 100)}` },
    ];
  },
};
