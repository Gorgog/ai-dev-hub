// Срез 22, критерий «в проекте старого формата wind-down пишет как сейчас»: проект из шаблона (`new-project` — память
// старого формата, без `memory/lessons/`). Команды эпизода и уборки v2 отвечают «памяти нового формата нет», код 0, и
// ничего не создают: ни `lessons/`, ни `events/`, `errors.md` побайтно прежний. Шаг старого формата в `wind-down` на
// месте (запись в `errors.md` с «повторов · механизм»), шаблон памяти не включает v2 (нет `lessons/`).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');

const SRC = 'срез 22 Acceptance: в проекте старого формата wind-down пишет как сейчас; new-project — память старого формата';

const tree = (dir) => {
  const out = [];
  const walk = (d, rel) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f), r = rel ? `${rel}/${f}` : f;
      if (fs.statSync(p).isDirectory()) walk(p, r); else out.push(`${r}\t${fs.readFileSync(p).toString('base64')}`);
    }
  };
  walk(dir, '');
  return out.join('\n');
};

module.exports = {
  id: 'H45', level: 'hook', mech: 'memory-skills', title: 'Память: wind-down в проекте старого формата пишет как сейчас',
  async run({ base, pluginDir, work }) {
    const episode = path.join(pluginDir, 'skills', 'wind-down', 'scripts', 'episode.cjs');
    const gc = path.join(pluginDir, 'skills', 'memory-gc', 'scripts', 'gc.cjs');
    if (!fs.existsSync(episode) || !fs.existsSync(gc)) {
      return [{ id: 'scripts-exist', source: SRC, pass: false, detail: 'нет episode.cjs или gc.cjs' }];
    }
    const { hub, proj } = makeHub(base, work);
    const mem = path.join(proj, 'memory');
    const wt = path.join(proj, 'worktrees', 'DEMO-1');
    fs.mkdirSync(wt, { recursive: true });
    const draft = path.join(work, 'draft.md');
    fs.writeFileSync(draft, ['---', 'id: dev-port', 'kind: knowledge', 'when: []', 'keys: [порт]', 'status: active', 'supersedes: []',
      'source: модель', 'created: 2026-11-05', '---', 'Дев-сервер слушает порт 3000 — синтетика.', 'Вторая строка.', ''].join('\n'));
    const before = tree(mem);
    const env = { ...process.env, AI_DEV_HUB: hub, HUB_MEMORY_DIR: '' };
    const runs = [[episode, 'add', draft], [episode, 'repeat', 'dev-port', '--note', 'снова'], [gc, 'dups'], [gc, 'retire'],
      [gc, 'review', '--model', 'm']].map(([cli, ...args]) => {
      const r = spawnSync(process.execPath, [cli, ...args], { cwd: wt, env, encoding: 'utf8', timeout: 20000 });
      return { args: args[0], code: r.status, out: r.stdout, err: r.stderr };
    });
    const bad = runs.filter((r) => r.code !== 0 || !/памяти нового формата нет/.test(r.out));
    const after = tree(mem);
    const skill = fs.readFileSync(path.join(pluginDir, 'skills', 'wind-down', 'SKILL.md'), 'utf8');
    const tmpl = path.join(base, 'templates', 'project', 'memory');
    return [
      { id: 'v1-said-code-0', source: SRC, pass: bad.length === 0,
        detail: bad.map((r) => `${r.args}: код ${r.code} ${(r.out || r.err).slice(0, 100)}`).join('; ') },
      { id: 'v1-nothing-written', kind: 'never', source: SRC, pass: after === before,
        detail: `было ${before.split('\n').length} файлов, стало ${after.split('\n').length}; lessons/: ${fs.existsSync(path.join(mem, 'lessons'))}` },
      { id: 'v1-step-kept', source: SRC, pass: /Нет `memory\/lessons\/` \(старый формат\)/.test(skill)
          && /повторов: 0 ·\s+механизм: нет · Ключи/.test(skill),
        detail: 'в wind-down нет шага старого формата (errors.md: повторов · механизм · ключи)' },
      { id: 'template-v1', source: SRC, pass: fs.existsSync(path.join(tmpl, 'errors.md')) && !fs.existsSync(path.join(tmpl, 'lessons')),
        detail: 'шаблон памяти не старого формата (нет errors.md или есть lessons/)' },
    ];
  },
};
