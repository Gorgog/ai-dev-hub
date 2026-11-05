// Срез 22, критерий «двойная запись: эпизод в новом формате и строка в errors.md совпадают по смыслу» — на песочнице
// проекта с `memory/lessons/`. Новый эпизод: файл урока = черновик, в `errors.md` ровно одна новая строка — та, что
// даёт экспорт v1 библиотеки (`recall export-v1`) для этого урока: все строки текста, дата, id. Повтор: событие
// `repeat` и строка «Повтор: …» с id. Черновик, похожий на урок, не пишется ни туда, ни туда. 6 сессий пишут
// эпизоды одновременно — в `errors.md` 6 строк, ни одна не потеряна и не склеена; записи v1 до них целы.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { makeHub } = require('../lib/hub.cjs');

const SRC = 'срез 22 Acceptance: двойная запись — эпизод v2 и строка в errors.md совпадают по смыслу (песочница)';
const PAR = 6;

const lesson = (id, lines, keys) => ['---', `id: ${id}`, 'kind: knowledge', 'when: []', `keys: [${keys.join(', ')}]`, 'status: active',
  'supersedes: []', 'source: модель', 'created: 2026-11-05', '---', ...lines, ''].join('\n');
// Unrelated synthetic topics: the parallel drafts must not look like repeats of each other.
const TOPICS = [
  ['Миграции схемы гонять только на тестовой копии базы.', 'Боевая схема отличается индексами.'],
  ['Скриншоты проверки снимать в окне шестнадцать на девять.', 'Узкое окно прячет правую колонку.'],
  ['Очередь писем дев-стенда смотреть в почтовом ящике-ловушке.', 'Логи приложения обрезают вложения.'],
  ['Кэш сборщика чистить после смены версии компилятора.', 'Старые артефакты дают фантомные ошибки типов.'],
  ['Порт отладчика занят соседним контейнером — выбирать свободный.', 'Иначе точки останова молча не срабатывают.'],
  ['Часовой пояс в тестах дат фиксировать переменной окружения.', 'На машине разработчика полночь сдвигает результат.'],
];

module.exports = {
  id: 'H46', level: 'hook', mech: 'memory-skills', title: 'Память: двойная запись эпизода — урок v2 и строка errors.md',
  async run({ base, pluginDir, work }) {
    const cli = path.join(pluginDir, 'skills', 'wind-down', 'scripts', 'episode.cjs');
    const store = path.join(pluginDir, 'lib', 'memory', 'store.cjs');
    if (!fs.existsSync(cli)) return [{ id: 'episode-exists', source: SRC, pass: false, detail: 'нет episode.cjs' }];
    const { hub, proj } = makeHub(base, work);
    const mem = path.join(proj, 'memory');
    const wt = path.join(proj, 'worktrees', 'DEMO-1');
    for (const d of [path.join(mem, 'lessons'), wt]) fs.mkdirSync(d, { recursive: true });
    const head = fs.readFileSync(path.join(mem, 'errors.md'), 'utf8');
    fs.writeFileSync(path.join(mem, 'lessons', 'vitest-from-package.md'), lesson('vitest-from-package',
      ['Тесты vitest в apps/web запускаются только из папки apps/web — синтетика.', 'Из корня раннер не находит тестов.'], ['vitest', 'apps/web']));
    const env = { ...process.env, AI_DEV_HUB: hub, HUB_MEMORY_DIR: '' };
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: wt, env, encoding: 'utf8', timeout: 20000 });
    const draft = (id, lines, keys) => { const f = path.join(work, `${id}.draft.md`); fs.writeFileSync(f, lesson(id, lines, keys)); return f; };
    const tail = () => fs.readFileSync(path.join(mem, 'errors.md'), 'utf8').slice(head.length).split('\n').filter(Boolean);

    // 1. A new episode.
    const d1 = draft('dev-port-3000', ['Дев-сервер apps/web слушает порт 3000 — проверка на localhost:3000.', 'Другой порт — не тот сервер.'], ['порт']);
    const r1 = run(['add', d1]);
    const lessonFile = path.join(mem, 'lessons', 'dev-port-3000.md');
    const sameFile = fs.existsSync(lessonFile) && fs.readFileSync(lessonFile, 'utf8') === fs.readFileSync(d1, 'utf8');
    const exp = spawnSync(process.execPath, ['-e', `const S=require(process.argv[1]);process.stdout.write(S.exportV1(process.argv[2])['errors.md'])`,
      store, mem], { encoding: 'utf8' }).stdout.split('\n').find((l) => l.endsWith(', урок dev-port-3000)'));
    const t1 = tail();
    const meaning = t1.length === 1 && t1[0] === exp && t1[0].includes('порт 3000') && t1[0].includes('не тот сервер')
      && t1[0].includes('2026-11-05') && t1[0].includes('dev-port-3000');

    // 2. A repeat of the lesson already there.
    const r2 = run(['repeat', 'vitest-from-package', '--note', 'снова из корня']);
    const t2 = tail();
    let events = [];
    try {
      events = fs.readdirSync(path.join(mem, 'events')).flatMap((f) => fs.readFileSync(path.join(mem, 'events', f), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    } catch { /* none */ }
    const repeatOk = r2.status === 0 && t2.length === 2 && /^- Повтор: снова из корня\. Тесты vitest .*урок vitest-from-package, повтор\)$/.test(t2[1])
      && events.filter((e) => e.kind === 'repeat' && e.lesson === 'vitest-from-package').length === 1;

    // 3. A draft close to a lesson: not written anywhere.
    const d3 = draft('vitest-root', ['Vitest из корня не находит тесты apps/web — запускать из apps/web.', 'Раннер не находит тестов.'], ['vitest', 'apps/web']);
    const r3 = run(['add', d3]);
    const dupOk = r3.status === 1 && /vitest-from-package/.test(r3.stderr) && !fs.existsSync(path.join(mem, 'lessons', 'vitest-root.md'))
      && tail().length === 2;

    // 4. Six sessions at once.
    const before = tail().length;
    const kids = TOPICS.slice(0, PAR).map((lines, i) => {
      const f = draft(`par-${i}`, lines, []);
      return new Promise((res) => {
        const c = spawn(process.execPath, [cli, 'add', f], { cwd: wt, env: { ...env, CLAUDE_SESSION_ID: `S${i}` } });
        let err = '';
        c.stderr.on('data', (x) => { err += x; });
        c.on('close', (code) => res({ code, err }));
      });
    });
    const outs = await Promise.all(kids);
    const t4 = tail().slice(before);
    const parOk = outs.every((o) => o.code === 0) && t4.length === PAR
      && TOPICS.slice(0, PAR).every((_, i) => t4.filter((l) => l.endsWith(`, урок par-${i})`)).length === 1);

    return [
      { id: 'new-episode-v2-file', source: SRC, pass: r1.status === 0 && sameFile, detail: `код ${r1.status} ${(r1.stderr || '').slice(0, 120)}; файл = черновик: ${sameFile}` },
      { id: 'new-episode-v1-line-same-meaning', source: SRC, pass: meaning, detail: `строки: ${JSON.stringify(t1)}; экспорт v1: ${exp}` },
      { id: 'repeat-event-and-line', source: SRC, pass: repeatOk, detail: `код ${r2.status}; строки ${JSON.stringify(t2.slice(1))}; repeat событий ${events.filter((e) => e.kind === 'repeat').length}` },
      { id: 'near-draft-not-written', kind: 'quiet', source: SRC, pass: dupOk, detail: `код ${r3.status}: ${(r3.stderr || r3.stdout).slice(0, 160)}` },
      { id: 'parallel-lines-kept', source: SRC, pass: parOk, detail: `коды ${outs.map((o) => o.code).join(',')}; строк ${t4.length}/${PAR}; ${outs.map((o) => o.err).join(' ').slice(0, 160)}` },
      { id: 'v1-records-kept', kind: 'never', source: SRC, pass: fs.readFileSync(path.join(mem, 'errors.md'), 'utf8').startsWith(head),
        detail: 'записи errors.md до эпизодов изменены' },
    ];
  },
};
