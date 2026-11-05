// Срез 22 (правило 7, приёмочный тест памяти 5 со стороны wind-down): агент ухода пишет эпизоды в конце сессии.
// Четыре задачи: новый эпизод (урок `knowledge`, не правило), повтор (событие `repeat` и повышение до правила с
// компилируемым `when`), класс «одного раза» (сразу `once`), проект старого формата (запись в `errors.md` как
// раньше, `lessons/` не появляется). В проекте v2 — двойная запись: ровно одна новая строка эпизода в `errors.md`.
// Всегда: память валидна, ошибок экранирования 0, Bash-записи в память нет (heredoc, `>>`, `node -e`), токены записаны.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { toolErrors } = require('./M11-memory-keeper-tasks.cjs');

const SRC = 'срез 22: правило 7 — эпизод всегда, правило по повтору; двойная запись; старый формат как сейчас';

const L = (id, kind, first, second, more = {}) => ['---', `id: ${id}`, `kind: ${kind}`,
  ...(more.when ? ['when:', ...more.when] : ['when: []']), `keys: [${(more.keys || []).join(', ')}]`, `status: ${more.status || 'active'}`,
  'supersedes: []', 'source: модель', 'created: 2026-10-01', '---', first, second, ''].join('\n');

const LESSONS = {
  'vitest-from-package': L('vitest-from-package', 'knowledge', 'Тесты vitest в apps/web запускаются только из папки apps/web.',
    'Из корня репозитория раннер падает с «No test files found».', { keys: ['vitest', 'apps/web'] }),
  'git-commit-msg-file': L('git-commit-msg-file', 'rule', 'Сообщение коммита с бэктиками — файлом через Write и `git commit -F <файл>`.',
    'В `-m "..."` шелл исполняет бэктики.', { keys: ['commit'], when: ['  - tool: ^Bash$', '    cmd: git\\s+commit[^|;&]*-m'] }),
};
const rel = (id) => `lessons/${id}.md`;

const PORT = 'Перед закрытием сессии запиши в память проекта эпизод (заметку сессии писать не нужно): сегодня проверяли '
  + 'вёрстку не на том порту — дев-сервер apps/web слушает 3000, а мы смотрели localhost:8080 и 15 минут искали несуществующий баг.';

const TASKS = [
  { key: 'episode', v2: true, changes: [], prompt: PORT,
    grade: ({ added, v1New }) => {
      const port = added.filter((a) => /3000/.test(a.text));
      return [
        { id: 'one-episode', pass: added.length === 1 && port.length === 1, detail: `новых уроков ${added.length}, про порт ${port.length}` },
        { id: 'episode-not-rule', pass: port.length === 1 && port[0].meta.kind === 'knowledge',
          detail: `kind ${port[0] ? port[0].meta.kind : '—'} (первый эпизод — knowledge, правило — по повтору)` },
        { id: 'double-write', pass: port.length === 1 && v1New.length === 1 && v1New[0].includes(port[0].id) && /3000/.test(v1New[0]),
          detail: `новых строк errors.md ${v1New.length}: ${v1New.join(' | ').slice(0, 200)}` }];
    } },
  { key: 'repeat', v2: true, changes: ['vitest-from-package'], prompt: 'Перед закрытием сессии запиши эпизод: снова запустили '
      + 'vitest из корня репозитория, а не из apps/web, — опять «No test files found», минус 10 минут.',
    grade: ({ added, events, meta, compileWhen, v1New }) => {
      const m = meta('vitest-from-package');
      const w = compileWhen(m.when || []);
      const fires = (cmd) => w.items.some((it) => (!it.tool || it.tool.test('Bash')) && (!it.cmd || it.cmd.test(cmd)) && !it.path && !it.body && !it.out);
      return [
        { id: 'repeat-event', pass: events.filter((e) => e.kind === 'repeat' && e.lesson === 'vitest-from-package').length === 1,
          detail: events.map((e) => `${e.kind}:${e.lesson}`).join(',') || 'событий нет' },
        { id: 'no-new-lesson', pass: added.length === 0, detail: `новых уроков ${added.length}` },
        { id: 'promoted-to-rule', pass: m.kind === 'rule', detail: `kind ${m.kind} (2-й эпизод — правило)` },
        { id: 'rule-trigger', pass: !w.problems.length && fires('npx vitest run'), detail: w.problems.join('; ') || `when ${JSON.stringify(m.when)}` },
        { id: 'double-write', pass: v1New.length === 1 && v1New[0].includes('vitest-from-package'), detail: `новых строк ${v1New.length}: ${v1New.join(' | ').slice(0, 200)}` }];
    } },
  { key: 'once', v2: true, changes: [], prompt: 'Перед закрытием сессии запиши эпизод: сессия чуть не выполнила git push в main '
      + 'без согласия пользователя — заметили в последний момент.',
    grade: ({ added, v1New }) => [
      { id: 'one-episode', pass: added.length === 1, detail: `новых уроков ${added.length}` },
      { id: 'once-at-once', pass: added.length === 1 && added[0].meta.kind === 'once', detail: `kind ${added[0] ? added[0].meta.kind : '—'} (пуш — класс «одного раза»)` },
      { id: 'double-write', pass: added.length === 1 && v1New.length === 1 && v1New[0].includes(added[0].id), detail: `новых строк ${v1New.length}` }] },
  { key: 'v1', v2: false, changes: [], prompt: PORT,
    grade: ({ mem, v1New }) => [
      { id: 'no-v2-created', kind: 'never', pass: !fs.existsSync(path.join(mem, 'lessons')) && !fs.existsSync(path.join(mem, 'events')),
        detail: 'в проекте старого формата появились lessons/ или events/' },
      { id: 'v1-record', pass: v1New.some((l) => /3000/.test(l) && /повторов:\s*\d+\s*·\s*механизм:/.test(l)),
        detail: `новые строки errors.md: ${v1New.join(' | ').slice(0, 200) || 'нет'}` }] },
];

// Bash that writes into the memory: a redirect, heredoc, tee, sed -i or a script writing files, aimed at errors.md or lessons/.
const MEM_TARGET = /errors(-index)?\.md|lessons\/|decisions\.md|events\//;
const WRITES = /(^|[^<>&0-9])>>?\s*\S|<<|\btee\b|\bsed\s+-i|writeFileSync|appendFileSync|\bcat\s*>/;
function bashMemoryWrites(events) {
  const out = [];
  for (const e of events || []) {
    if (!e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type !== 'tool_use' || b.name !== 'Bash') continue;
      const cmd = String((b.input && b.input.command) || '');
      if (MEM_TARGET.test(cmd) && WRITES.test(cmd)) out.push(cmd.slice(0, 160));
    }
  }
  return out;
}

function snapshot(mem) {
  const out = {};
  for (const d of ['lessons', 'decisions']) {
    const dir = path.join(mem, d);
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.md')) : []) out[`${d}/${f}`] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return out;
}
// v1 records of errors.md: a record starts with «- » and goes on over indented lines (a model wraps long records).
function v1Records(text) {
  const out = [];
  for (const l of text.split('\n')) {
    if (l.startsWith('- ')) out.push(l);
    else if (/^\s+\S/.test(l) && out.length) out[out.length - 1] += ` ${l.trim()}`;
  }
  return out;
}
const errorsMd = (mem) => { try { return fs.readFileSync(path.join(mem, 'errors.md'), 'utf8'); } catch { return ''; } };

function gradeTask(task, { run, ctx }) {
  const lib = (m) => require(path.join(ctx.hub, 'plugin', 'lib', 'memory', m));
  const { parseLesson, validateLesson, compileWhen } = lib('format.cjs');
  const { readEvents } = lib('events.cjs');
  const now = snapshot(ctx.mem);
  const meta = (id) => (now[rel(id)] ? parseLesson(now[rel(id)]).meta : {});
  const added = Object.keys(now).filter((p) => !(p in ctx.before)).map((p) => ({ id: path.basename(p, '.md'), text: now[p], meta: parseLesson(now[p]).meta }));
  const { events, problems: evProblems } = readEvents(ctx.mem);
  const invalid = Object.entries(now).flatMap(([p, t]) => validateLesson(Buffer.from(t), { file: `memory/${p}` }).map((x) => `${p}: ${x}`));
  const allowed = new Set(task.changes.map(rel));
  const touched = Object.keys(ctx.before).filter((p) => now[p] !== ctx.before[p] && !allowed.has(p));
  const v1 = errorsMd(ctx.mem);
  const v1Kept = v1.startsWith(ctx.v1Before);
  const v1New = v1Kept ? v1Records(v1.slice(ctx.v1Before.length)) : [];
  const errs = toolErrors(run.events);
  const escaping = errs.filter((e) => e.escaping).map((e) => e.text);
  const bashWrites = bashMemoryWrites(run.events);
  const result = [...(run.events || [])].reverse().find((e) => e.type === 'result') || {};
  const u = result.usage || {};
  const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  return [
    ...task.grade({ mem: ctx.mem, meta, added, events, compileWhen, v1New }).map((c) => ({ source: SRC, ...c })),
    { id: 'memory-valid', source: SRC, pass: invalid.length === 0 && evProblems.length === 0, detail: [...invalid, ...evProblems].slice(0, 3).join('; ') },
    { id: 'others-untouched', kind: 'quiet', source: SRC, pass: touched.length === 0, detail: `тронуты не те уроки: ${touched.join(', ')}` },
    { id: 'v1-records-kept', kind: 'never', source: SRC, pass: v1Kept, detail: 'записи errors.md до сессии изменены' },
    { id: 'no-bash-memory-write', kind: 'never', source: SRC, pass: bashWrites.length === 0, detail: bashWrites.slice(0, 2).join(' | ') },
    { id: 'no-escaping-errors', kind: 'never', source: SRC, pass: escaping.length === 0, detail: escaping.slice(0, 2).join(' | ') },
    { id: 'tool-errors', observe: true, source: SRC, pass: errs.length === 0, detail: `ошибок инструментов ${errs.length}: ${errs.slice(0, 2).map((e) => e.text).join(' | ')}` },
    { id: 'tokens', observe: true, source: SRC, pass: true,
      detail: `токены ${tokens} (вход ${u.input_tokens || 0}, кэш ${(u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)}, выход ${u.output_tokens || 0}), ${run.turns} ходов` },
  ];
}

module.exports = TASKS.map((task) => ({
  id: `M12-${task.key}`, level: 'model', mech: 'memory-skills', title: `Агент ухода: эпизод в конце сессии — ${task.key}`, task,
  async setup({ base, work }) {
    const files = task.v2 ? Object.fromEntries(Object.entries(LESSONS).map(([id, t]) => [rel(id), t])) : {};
    const { hub, proj } = makeHub(base, work, { memory: files });
    const repo = path.join(proj, 'repo');
    gitRepo(repo, { 'apps/web/package.json': '{ "name": "web", "private": true }\n' });
    const mem = path.join(proj, 'memory');
    return { cwd: repo, hubDir: hub, prompt: task.prompt, maxTurns: 16, timeoutSec: 600,
      ctx: { mem, hub, before: snapshot(mem), v1Before: errorsMd(mem) } };
  },
  async grade({ run, ctx }) { return gradeTask(task, { run, ctx }); },
}));
module.exports.bashMemoryWrites = bashMemoryWrites;
