// setup (срез 17): на машине без настроек хаба SessionStart говорит «не хватает N настроек» и зовёт /hub:setup; после
// установки каждой настройки скриптом скилла (по одной) — проверка даёт 0 и старт молчит. Машина синтетическая:
// свой CLAUDE_CONFIG_DIR, хаб — git с main, фейковый `claude` на PATH пишет установленную версию плагина.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { runEvent } = require('../lib/hooks.cjs');

const SRC = 'план 17, Acceptance 1: «на машине без нужных настроек — строка „не хватает N“; после /hub:setup — 0»';
// Проект без доски диспетчера: файлы диспетчера (профиль, правила замка, checks.json) не нужны и не считаются.
const ALL = ['auto-memory', 'bash-cwd', 'journal-retention', 'plugin-version', 'status-line'];

function stand(base, work, canary) {
  const { hub, proj } = makeHub(base, work, { extra: canary ? { 'canary.json': JSON.stringify({ mechanisms: ['setup'] }) } : {} });
  const hubGit = gitRepo(hub, { 'README.md': 'мини-хаб\n' });
  const main = hubGit('rev-parse', 'HEAD');
  const repo = path.join(proj, 'repo');
  gitRepo(repo, { 'a.txt': '1\n' });
  const claude = path.join(work, 'claude');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), ['#!/bin/sh',
    'if [ "$1 $2 $3" = "plugin update hub@hub" ]; then mkdir -p "$CLAUDE_CONFIG_DIR/plugins"',
    `  printf '{"plugins":{"hub@hub":[{"gitCommitSha":"${main}"}]}}' > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"; fi`,
    'exit 0', ''].join('\n'), { mode: 0o755 });
  const env = { AI_DEV_HUB: hub, CLAUDE_CONFIG_DIR: claude, PATH: `${bin}:${process.env.PATH}` };
  return { hub, repo, env };
}

const start = (pluginDir, s) => {
  const res = runEvent(pluginDir, 'SessionStart', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'eval', cwd: s.repo }, s.env);
  const text = res.map((r) => r.stdout + (r.json && r.json.hookSpecificOutput ? r.json.hookSpecificOutput.additionalContext || '' : '')).join('\n');
  const blocked = res.some((r) => r.code === 2 || (r.json && (r.json.continue === false || r.json.decision === 'block')));
  return { text, blocked };
};

module.exports = {
  id: 'H31', level: 'hook', mech: 'setup', title: 'setup: «не хватает N настроек» и 0 после /hub:setup',
  async run({ base, pluginDir, work }) {
    const s = stand(base, path.join(work, 'on'), true);
    const before = start(pluginDir, s);
    const script = path.join(s.hub, 'plugin', 'skills', 'setup', 'scripts', 'setup.cjs');
    const applied = ALL.map((id) => spawnSync(process.execPath, [script, 'apply', id], { cwd: s.repo, env: { ...process.env, ...s.env }, encoding: 'utf8' }));
    const after = start(pluginDir, s);
    const check = spawnSync(process.execPath, [script, 'check'], { cwd: s.repo, env: { ...process.env, ...s.env }, encoding: 'utf8' });
    const off = stand(base, path.join(work, 'off'), false);
    const quiet = start(pluginDir, off);
    return [
      { id: 'names-missing', source: SRC, pass: new RegExp(`не хватает ${ALL.length} настроек[^\\n]*/hub:setup`).test(before.text),
        detail: `старт без настроек не назвал «не хватает ${ALL.length}»: ${before.text.slice(0, 200)}` },
      { id: 'setup-applies-each', source: SRC, pass: applied.every((r) => r.status === 0),
        detail: applied.map((r, i) => `${ALL[i]}: ${r.status} ${r.stderr.trim()}`).filter((x) => !/: 0 $/.test(x)).join('; ') },
      { id: 'zero-after-setup', source: SRC, pass: /не хватает 0 настроек/.test(check.stdout) && !/не хватает/.test(after.text),
        detail: `после установки: ${check.stdout.split('\n').pop() || check.stdout.slice(-120)} / старт: ${after.text.slice(0, 120)}` },
      { id: 'not-blocked', kind: 'quiet', source: SRC, pass: !before.blocked && !after.blocked, detail: 'SessionStart заблокировал старт' },
      { id: 'canary-only', kind: 'quiet', source: 'реестр: стадия canary — только в проектах из canary.json', pass: !/не хватает/.test(quiet.text),
        detail: 'модуль заговорил в проекте без канарейки' },
    ];
  },
};
