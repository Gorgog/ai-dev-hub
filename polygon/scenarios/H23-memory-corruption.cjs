// Приёмочный тест памяти 2 (acceptance §2), уровень хранилища: порча — NUL в уроке, обрезанная последняя строка
// jsonl, удалённый и битый индекс. Проверка памяти (`recall check`) называет каждую; поиск не заблокирован ни разу
// и отвечает; индекс пересобран ≤ 1 с; файл горячего пути `.triggers.json` читается. Что SessionStart называет
// порчу в брифе — контракт H25 (подключение памяти к хукам, срез 21).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = 'acceptance §2 тест 2 [Г]: NUL в уроке, обрезанная строка jsonl, удалённый или битый индекс';
const N = 250;

function lessonText(i) {
  const id = `l${String(i).padStart(3, '0')}`;
  const topic = ['git', 'тесты', 'миграции', 'браузер', 'замок', 'память', 'сборка'][i % 7];
  return { id, text: ['---', `id: ${id}`, 'kind: rule', 'when:', '  - tool: ^Bash$', `    cmd: \\bcmd${i}\\b`,
    `keys: [${topic}, k${i}]`, 'status: active', 'supersedes: []', 'source: модель', 'created: 2026-10-01', '---',
    `Урок ${i} про ${topic}: синтетика полигона, правило номер ${i}.`, 'Вторая строка урока.', ''].join('\n') };
}

module.exports = {
  id: 'H23', level: 'hook', mech: 'memory-store', title: 'Память: порча — NUL, рваный jsonl, удалённый и битый индекс (тест 2)',
  async run({ pluginDir, work }) {
    const cli = path.join(pluginDir, 'skills', 'recall', 'scripts', 'recall.cjs');
    if (!fs.existsSync(cli)) return [{ id: 'recall-exists', source: SRC, pass: false, detail: 'нет команды recall' }];
    const mem = path.join(work, 'memory');
    fs.mkdirSync(path.join(mem, 'lessons'), { recursive: true });
    for (let i = 0; i < N; i++) { const l = lessonText(i); fs.writeFileSync(path.join(mem, 'lessons', `${l.id}.md`), l.text); }
    const recall = (...args) => {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [cli, '--memory', mem, ...args], { encoding: 'utf8', timeout: 20000 });
      return { code: r.status, out: r.stdout || '', err: r.stderr || '', ms: Date.now() - t0 };
    };
    for (let i = 0; i < 20; i++) recall('repeat', `l${String(i).padStart(3, '0')}`);
    recall('find', 'миграции');
    // Corruption, all at once: NUL in a lesson, a torn last event line, no index.
    fs.appendFileSync(path.join(mem, 'lessons', 'l007.md'), 'хвост после вставки \u0000 из буфера\n');
    const ev = fs.readdirSync(path.join(mem, 'events'))[0];
    const evLines = fs.readFileSync(path.join(mem, 'events', ev), 'utf8').split('\n').filter(Boolean).length;
    fs.appendFileSync(path.join(mem, 'events', ev), '{"at":"2026-11-05T10:00:00.000Z","kind":"sho');
    fs.rmSync(path.join(mem, '.index.db'));
    const check1 = recall('check');
    const find1 = recall('find', 'урок', 'про', 'миграции');
    fs.rmSync(path.join(mem, '.index.db'));
    const find2 = recall('find', 'урок', 'про', 'браузер');
    fs.writeFileSync(path.join(mem, '.index.db'), 'SQLite format 3\u0000 — а дальше мусор, не база');
    const find3 = recall('find', 'урок', 'про', 'замок');
    fs.writeFileSync(path.join(mem, '.index.db'), Buffer.alloc(4096, 7));
    const check2 = recall('check');
    let triggers = null;
    try { triggers = JSON.parse(fs.readFileSync(path.join(mem, '.triggers.json'), 'utf8')); } catch { /* below */ }
    const found = (r, topic) => r.code === 0 && new RegExp(`\\[по касанию · rule\\] Урок \\d+ про ${topic}`).test(r.out);
    return [
      { id: 'check-names-nul', source: SRC, pass: /lessons\/l007\.md[^\n]*NUL/.test(check1.out), detail: check1.out.slice(0, 300) || check1.err },
      { id: 'check-names-torn-jsonl', source: SRC, pass: new RegExp(`${ev.replace('.', '\\.')}:${evLines + 1}`).test(check1.out),
        detail: `нет «${ev}:${evLines + 1}» в выводе check` },
      { id: 'check-names-missing-index', source: SRC, pass: /индекс/.test(check1.out), detail: 'check молчит об удалённом индексе' },
      { id: 'check-names-broken-index', source: SRC, pass: /индекс[^\n]*бит/.test(check2.out), detail: check2.out.slice(0, 300) || check2.err },
      { id: 'find-not-blocked', kind: 'quiet', source: SRC, pass: found(find1, 'миграции') && found(find2, 'браузер') && found(find3, 'замок'),
        detail: `коды ${find1.code}/${find2.code}/${find3.code}: ${(find1.err || find2.err || find3.err).slice(0, 200)}` },
      { id: 'rebuild-under-1s', source: SRC, pass: Math.max(find2.ms, find3.ms) <= 1000,
        detail: `поиск с пересборкой (процесс целиком): удалён ${find2.ms} мс, битый ${find3.ms} мс` },
      { id: 'triggers-readable', kind: 'quiet', source: SRC, pass: Boolean(triggers && triggers.lessons && triggers.lessons.length >= N - 1),
        detail: `.triggers.json: ${triggers ? triggers.lessons.length : 'не читается'} уроков` },
    ];
  },
};
