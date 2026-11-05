#!/usr/bin/env node
// Latency of the hook path as Claude Code pays it: a whole `node <hook>` process per call, event JSON on stdin.
// Compares PreToolUse of a git ref (v1 baseline ef519e3 by default) with this working tree, interleaved, in a
// synthetic hub (projects/demo/worktrees/K-1 with the polygon's dispatch-rules.json), and times an event with no
// modules (PostToolUse) and a bare `node -e ''` for the floor. Light: no model, a few seconds.
// usage: node plugin/hooks/bench.cjs [--ref ef519e3] [-n 200]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ref = opt('--ref', 'ef519e3');
const n = Number(opt('-n', 200));
const root = path.resolve(__dirname, '..', '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-bench-'));
try {
  const hub = path.join(tmp, 'hub');
  const wt = path.join(hub, 'projects', 'demo', 'worktrees', 'K-1');
  fs.mkdirSync(wt, { recursive: true });
  fs.copyFileSync(path.join(root, 'polygon', 'fixtures', 'dispatch-rules.json'), path.join(hub, 'projects', 'demo', 'dispatch-rules.json'));
  const base = path.join(tmp, 'base');
  fs.mkdirSync(base);
  execFileSync('sh', ['-c', `git -C "${root}" archive "${ref}" plugin | tar -x -C "${base}"`]);
  const env = { ...process.env, AI_DEV_HUB: hub, HUB_LOG_DIR: path.join(tmp, 'logs'), CLAUDE_PLUGIN_DATA: path.join(tmp, 'data') };
  delete env.HUB_OFF;

  // The command of <event> from a plugin's hooks.json, as argv.
  const cmd = (plugin, event) => {
    const h = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks[event][0].hooks[0];
    return [h.command, ...(h.args || [])].map((s) => s.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin));
  };
  const ev = (event) => JSON.stringify({ hook_event_name: event, session_id: 'bench', cwd: wt, tool_name: 'Bash', tool_input: { command: 'git status --short' } });
  const once = (argv, input) => {
    const t = process.hrtime.bigint();
    spawnSync(argv[0], argv.slice(1), { input, env, encoding: 'utf8' });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const runs = {
    [`PreToolUse ${ref}`]: [cmd(path.join(base, 'plugin'), 'PreToolUse'), ev('PreToolUse')],
    'PreToolUse ветка': [cmd(path.join(root, 'plugin'), 'PreToolUse'), ev('PreToolUse')],
    'пустое событие (PostToolUse)': [cmd(path.join(root, 'plugin'), 'PostToolUse'), ev('PostToolUse')],
    "node -e ''": [[process.execPath, '-e', ''], ''],
  };
  const times = Object.fromEntries(Object.keys(runs).map((k) => [k, []]));
  for (const [argv, input] of Object.values(runs)) once(argv, input); // warm the file cache
  for (let i = 0; i < n; i++) for (const [k, [argv, input]] of Object.entries(runs)) times[k].push(once(argv, input));
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
  console.log(`node ${process.version}, ${n} вызовов на строку, вперемешку`);
  for (const [k, a] of Object.entries(times)) console.log(`${k.padEnd(30)} p50 ${q(a, 0.5).toFixed(1)} мс  p95 ${q(a, 0.95).toFixed(1)} мс`);
  const d = q(times['PreToolUse ветка'], 0.95) - q(times[`PreToolUse ${ref}`], 0.95);
  console.log(`p95 PreToolUse: ветка − ${ref} = ${d >= 0 ? '+' : ''}${d.toFixed(1)} мс (порог acceptance: ≤ +15 мс)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
