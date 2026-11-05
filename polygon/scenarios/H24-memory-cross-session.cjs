// Приёмочный тест памяти 8 (acceptance §2): урок, записанный сессией A, виден `recall` сессии B без перезапуска —
// 100 %. Сессии — разные процессы с разными id в проекте фикстуры (cwd в worktree, память находится сама); A пишет
// файл урока целиком, как Write, B ищет сразу после записи, без паузы. Правка урока без смены размера тоже видна.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');

const SRC = 'acceptance §2 тест 8 [П]: урок сессии A виден recall сессии B — 100 % без перезапуска';
const WORDS = ['альфа', 'бравосо', 'чарли', 'дельтас', 'эхолот', 'фокстрот', 'гольфист', 'отельер', 'индиго', 'джульетта'];

module.exports = {
  id: 'H24', level: 'hook', mech: 'memory-store', title: 'Память: урок сессии A виден recall сессии B без перезапуска (тест 8)',
  async run({ base, pluginDir, work }) {
    const cli = path.join(pluginDir, 'skills', 'recall', 'scripts', 'recall.cjs');
    if (!fs.existsSync(cli)) return [{ id: 'recall-exists', source: SRC, pass: false, detail: 'нет команды recall' }];
    const { hub, proj } = makeHub(base, work);
    const mem = path.join(proj, 'memory');
    const wtA = path.join(proj, 'worktrees', 'DEMO-1'), wtB = path.join(proj, 'worktrees', 'DEMO-2');
    for (const d of [path.join(mem, 'lessons'), wtA, wtB]) fs.mkdirSync(d, { recursive: true });
    const lesson = (id, word) => ['---', `id: ${id}`, 'kind: rule', 'when: []', `keys: [${word}]`, 'status: active',
      'supersedes: []', 'source: модель', 'created: 2026-11-05', '---', `Урок сессии A: слово ${word} — синтетика.`, 'Вторая строка.', ''].join('\n');
    fs.writeFileSync(path.join(mem, 'lessons', 'seed.md'), lesson('seed', 'затравка'));
    const session = (id, cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, AI_DEV_HUB: hub, CLAUDE_SESSION_ID: id, HUB_MEMORY_DIR: '' } });
    const writeA = (id, text) => spawnSync(process.execPath, ['-e',
      'require("fs").writeFileSync(process.argv[1], process.argv[2])', path.join(mem, 'lessons', `${id}.md`), text],
    { cwd: wtA, env: { ...process.env, CLAUDE_SESSION_ID: 'A' } });
    const warm = session('B', wtB, ['find', 'затравка']);
    let seen = 0, edits = 0;
    const misses = [];
    WORDS.forEach((w, i) => {
      writeA(`a-${i}`, lesson(`a-${i}`, w));
      const r = session('B', wtB, ['find', w]);
      if (r.status === 0 && r.stdout.includes(`a-${i} [`)) seen++; else misses.push(`${w}: ${(r.stdout || r.stderr).slice(0, 80)}`);
    });
    // An edit that keeps the size: only the mtime tells it changed.
    for (const [i, w] of [[0, 'омега'], [3, 'сигмас']]) {
      const f = path.join(mem, 'lessons', `a-${i}.md`);
      const old = fs.readFileSync(f, 'utf8');
      const neu = old.replace(WORDS[i], w.padEnd(WORDS[i].length, 'х').slice(0, WORDS[i].length));
      writeA(`a-${i}`, neu);
      const r = session('B', wtB, ['find', w.padEnd(WORDS[i].length, 'х').slice(0, WORDS[i].length)]);
      if (r.status === 0 && r.stdout.includes(`a-${i} [`)) edits++; else misses.push(`правка ${w}: ${(r.stdout || r.stderr).slice(0, 80)}`);
    }
    return [
      { id: 'warm-up', kind: 'quiet', source: SRC, pass: warm.status === 0 && warm.stdout.includes('seed ['),
        detail: `сессия B не нашла затравку: ${(warm.stdout || warm.stderr).slice(0, 160)}` },
      { id: 'b-sees-a-lessons', source: SRC, pass: seen === WORDS.length, detail: `видно ${seen}/${WORDS.length}; ${misses.join('; ')}` },
      { id: 'b-sees-a-edit', source: SRC, pass: edits === 2, detail: `правки той же длины видны ${edits}/2; ${misses.join('; ')}` },
    ];
  },
};
