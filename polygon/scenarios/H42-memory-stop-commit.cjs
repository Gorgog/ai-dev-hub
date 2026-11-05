// Память в хуках (срез 21): Stop переносит события уроков своей сессии из журнала подачи в memory/events проекта (один
// раз) и коммитит историю памяти в её git под `flock -n`: занято — пропуск без ожидания (P14), нечего — без коммита,
// нет memory/.git — хук git не заводит.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'plan 21: «история памяти коммитится хуком под flock» + «коммит памяти: Stop, flock с таймаутом 0 — занято, пропустить» (P14)';
const lesson = ['---', 'id: heredoc-script', 'kind: rule', 'when:', '  - tool: ^Bash$', "    cmd: <<\\s*'?EOF", 'keys: []', 'status: active', 'supersedes: []',
  'source: модель', 'created: 2026-10-01', '---', 'Скрипт — файлом через Write, не heredoc в Bash.', 'Вторая строка урока.', ''].join('\n');
const HEREDOC = "python3 - <<'EOF'\nprint(1)\nEOF";
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)));
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: cleanEnv() });
const count = (dir) => Number(git(dir, 'rev-list', '--count', 'HEAD').stdout.trim() || 0);

function setup({ base, pluginDir, work }, name, { withGit }) {
  const { hub, proj } = makeHub(base, path.join(work, name), { memory: { 'lessons/heredoc-script.md': lesson },
    extra: { 'canary.json': JSON.stringify({ mechanisms: ['delivery', 'memory'] }) } });
  const mem = path.join(proj, 'memory');
  if (withGit) {
    git(mem, 'init', '-q', '-b', 'main');
    git(mem, 'config', 'user.email', 'eval@example.test');
    git(mem, 'config', 'user.name', 'eval');
    git(mem, 'add', '-A');
    git(mem, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  }
  const cwd = path.join(proj, 'worktrees', 'K-1');
  fs.mkdirSync(cwd, { recursive: true });
  const env = { AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(work, name, 'data') };
  const ev = (event, extra) => runEvent(pluginDir, event, { hook_event_name: event, session_id: `eval-h42-${name}`, permission_mode: 'default', cwd, ...extra }, env);
  return { mem, ev };
}
const memEvents = (mem) => {
  const d = path.join(mem, 'events');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }));
};

module.exports = {
  id: 'H42', level: 'hook', mech: 'memory-hooks', title: 'Stop: события уроков в память проекта, коммит под flock (21)',
  async run(ctx) {
    const a = setup(ctx, 'a', { withGit: true });
    a.ev('SessionStart', { source: 'startup' });
    a.ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: HEREDOC } });
    a.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: HEREDOC }, tool_response: { stdout: '1\n', stderr: '' } });
    a.ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: HEREDOC } });
    const c0 = count(a.mem);
    const stop1 = a.ev('Stop', { stop_hook_active: false });
    const mirrored = memEvents(a.mem).filter((e) => e.lesson === 'heredoc-script').map((e) => e.kind);
    const c1 = count(a.mem);
    a.ev('Stop', { stop_hook_active: false });
    const again = memEvents(a.mem).filter((e) => e.lesson === 'heredoc-script').length;
    const c2 = count(a.mem);

    const lock = path.join(a.mem, '.git', 'hub-memory.lock');
    const holder = spawn('flock', [lock, 'sleep', '5'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    fs.appendFileSync(path.join(a.mem, 'lessons', 'heredoc-script.md'), '');
    a.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't3', tool_input: { command: 'ls' }, tool_response: { stdout: '', stderr: '' } });
    fs.writeFileSync(path.join(a.mem, 'lessons', 'heredoc-script.md'), lesson.replace('Вторая строка урока.', 'Вторая строка, правка.'));
    const t0 = Date.now();
    a.ev('Stop', { stop_hook_active: false });
    const busyMs = Date.now() - t0;
    const c3 = count(a.mem);
    holder.kill();

    const b = setup(ctx, 'b', { withGit: false });
    b.ev('SessionStart', { source: 'startup' });
    b.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: HEREDOC }, tool_response: { stdout: '1\n', stderr: '' } });
    const stopB = b.ev('Stop', { stop_hook_active: false });

    const blocked = (res) => res.some((r) => r.code === 2 || (r.json && r.json.decision === 'block'));
    return [
      { id: 'events-mirrored', source: SRC, pass: mirrored.includes('shown') && mirrored.includes('deny'), detail: `в memory/events: ${mirrored.join(',') || 'пусто'}` },
      { id: 'mirrored-once', kind: 'quiet', source: SRC, pass: again === mirrored.length, detail: `после второго Stop строк ${again}, было ${mirrored.length}` },
      { id: 'committed', source: SRC, pass: c1 === c0 + 1 && /events\//.test(git(a.mem, 'show', '--stat', 'HEAD').stdout), detail: `коммитов ${c0} → ${c1}` },
      { id: 'nothing-no-commit', kind: 'quiet', source: SRC, pass: c2 === c1, detail: `второй Stop без изменений: ${c1} → ${c2}` },
      { id: 'busy-skips-fast', kind: 'quiet', source: 'P14: «занято → пропуск без ожидания»', pass: c3 === c2 && busyMs < 2000, detail: `занято: ${busyMs} мс, коммитов ${c2} → ${c3}` },
      { id: 'stop-never-blocks', kind: 'quiet', source: SRC, pass: !blocked(stop1) && !blocked(stopB), detail: 'Stop памяти заблокировал' },
      { id: 'no-git-not-created', kind: 'quiet', source: SRC, pass: !fs.existsSync(path.join(b.mem, '.git')), detail: 'хук завёл git памяти сам' },
    ];
  },
};
