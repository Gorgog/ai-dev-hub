// Приёмочный тест памяти 5 (acceptance §2): агент ухода за памятью v2 — 6 задач (новый урок, повтор, слияние двух,
// замена, отставка, правка `when`) × 3 повтора. Порог: все результаты верны; ошибок инструментов из-за экранирования
// 0; токены на задачу записаны (наблюдение). Модель получает фразу пользователя и плагин версии; как сделать —
// её выбор (скилл recall, Write/Edit). Проверка — по файлам памяти фикстуры, событиям и транскрипту.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');

const SRC = 'acceptance §2 тест 5 [Г]: 6 задач агента ухода × 3 — все верны, экранирование 0, токены записаны';

const L = (id, first, second, more = {}) => ['---', `id: ${id}`, `kind: ${more.kind || 'rule'}`,
  ...(more.when ? ['when:', ...more.when] : ['when: []']), `keys: [${(more.keys || []).join(', ')}]`, `status: ${more.status || 'active'}`,
  'supersedes: []', 'source: модель', `created: ${more.created || '2026-10-01'}`, '---', first, second, ''].join('\n');

const LESSONS = {
  'git-commit-msg-file': L('git-commit-msg-file', 'Сообщение коммита с кавычками или бэктиками — файлом через Write и `git commit -F <файл>`.',
    'В `-m "..."` шелл исполняет бэктики: сообщение портится молча.', { keys: ['commit', 'сообщение коммита'],
      when: ['  - tool: ^Bash$', '    cmd: git\\s+commit[^|;&]*-m'] }),
  'prisma-generate-after-checkout': L('prisma-generate-after-checkout', 'После переключения ветки — генерация клиента prisma до юнит-тестов.',
    'Иначе тесты падают на старом клиенте: «Cannot read properties of undefined».', { keys: ['prisma', 'checkout'] }),
  'prisma-client-stale': L('prisma-client-stale', 'Красные тесты сразу после смены ветки — сначала проверь, свежий ли клиент prisma.',
    'Схема на ветке новее клиента в node_modules — фантомные падения.', { keys: ['prisma', 'тесты'] }),
  'dev-port-3000': L('dev-port-3000', 'Дев-сервер apps/web слушает порт 3000 — проверка в браузере на localhost:3000.',
    'Другой порт — значит, запущен не тот сервер.', { keys: ['порт', 'дев-сервер'] }),
  'mailhog-check': L('mailhog-check', 'Письма дев-стенда смотреть в mailhog, не в логах приложения.',
    'В логах письмо обрезано, вложения не видны.', { keys: ['mailhog', 'почта'] }),
  'prettier-write': L('prettier-write', 'Форматтер с записью по всему каталогу переписывает чужие файлы — только по своим файлам ветки.',
    'Диф раздувается, ревью тонет в форматировании.', { keys: ['prettier'], when: ['  - tool: ^Bash$', '    cmd: prettier[^|;&]*--write'] }),
  'no-env-edit': L('no-env-edit', 'Файлы .env не править и не читать вслух: там секреты.', 'Нужна переменная — спросить пользователя.',
    { kind: 'once', status: 'core', keys: ['env', 'секреты'] }),
};

const rel = (id) => `lessons/${id}.md`;

// Each task: the user's phrase, what may change, and how to tell it is done right (checks on the memory after).
const TASKS = [
  { key: 'new', changes: [], prompt: 'Запиши в память проекта урок: тесты vitest в apps/web запускаются только из папки apps/web — '
      + 'из корня репозитория раннер падает с «No test files found». Вчера потеряли на этом 20 минут.',
    grade: ({ added, events }) => {
      const hits = added.filter((a) => /vitest/i.test(a.text) && /apps\/web/.test(a.text));
      return [{ id: 'new-lesson', pass: hits.length === 1 && added.length === 1, detail: `новых уроков ${added.length}, про vitest ${hits.length}` },
        { id: 'no-stray-events', pass: !events.some((e) => ['merged', 'superseded', 'retired'].includes(e.kind)), detail: events.map((e) => e.kind).join(',') }];
    } },
  { key: 'repeat', changes: [], prompt: 'Опять сломалось сообщение коммита: бэктики в `git commit -m` выполнились шеллом. '
      + 'Урок про это в памяти уже есть — отметь, что он повторился.',
    grade: ({ added, events }) => [
      { id: 'repeat-event', pass: events.filter((e) => e.kind === 'repeat' && e.lesson === 'git-commit-msg-file').length === 1,
        detail: events.map((e) => `${e.kind}:${e.lesson}`).join(',') || 'событий нет' },
      { id: 'no-new-lesson', pass: added.length === 0, detail: `новых файлов ${added.length}` }] },
  { key: 'merge', changes: ['prisma-generate-after-checkout', 'prisma-client-stale'], prompt: 'В памяти два урока про одно и то же — '
      + 'клиент prisma после смены ветки. Слей их в один, чтобы ничего из двух не потерялось.',
    grade: ({ meta, text, events, added }) => {
      const ids = ['prisma-generate-after-checkout', 'prisma-client-stale'];
      const live = ids.filter((id) => ['active', 'core'].includes(meta(id).status));
      const gone = ids.filter((id) => meta(id).status === 'superseded');
      // Two right outcomes: one lesson absorbs the other, or both go into a new one.
      const intoOld = live.length === 1 && gone.length === 1 && added.length === 0;
      const intoNew = live.length === 0 && gone.length === 2 && added.length === 1;
      const target = intoOld ? { id: live[0], body: text(live[0]), meta: meta(live[0]) } : intoNew ? { ...added[0], body: added[0].text } : null;
      const body = target ? target.body : '';
      return [
        { id: 'one-left', pass: intoOld || intoNew, detail: `живых ${live.join(',') || '—'}, ушли ${gone.join(',') || '—'}, новых ${added.length}` },
        { id: 'merged-event', pass: gone.length > 0 && gone.every((g) => events.some((e) => ['merged', 'superseded'].includes(e.kind) && e.lesson === g)),
          detail: events.map((e) => `${e.kind}:${e.lesson}`).join(',') || 'событий нет' },
        // Each regex matches only its own lesson's text: the target must hold the text of the one it absorbed too.
        { id: 'content-kept', pass: /undefined|старом клиенте|генерац/i.test(body) && /node_modules|фантом|новее клиента/i.test(body),
          detail: body.slice(0, 200) },
        { id: 'supersedes-set', pass: Boolean(target) && gone.every((g) => (target.meta.supersedes || []).includes(g)),
          detail: `supersedes у ${target ? target.id : '—'}: ${JSON.stringify(target ? target.meta.supersedes : null)}` }];
    } },
  { key: 'replace', changes: ['dev-port-3000'], prompt: 'Урок про порт дев-сервера apps/web устарел: после перехода на vite он слушает 5173, '
      + 'а не 3000. Замени урок новым.',
    grade: ({ meta, events, added }) => {
      const neu = added.filter((a) => /5173/.test(a.text));
      return [
        { id: 'new-lesson-5173', pass: neu.length === 1, detail: `новых ${added.length}, с 5173 — ${neu.length}` },
        { id: 'old-superseded', pass: meta('dev-port-3000').status === 'superseded', detail: `статус старого: ${meta('dev-port-3000').status}` },
        { id: 'supersedes-link', pass: neu.length === 1 && (neu[0].meta.supersedes || []).includes('dev-port-3000'), detail: JSON.stringify(neu[0] && neu[0].meta.supersedes) },
        { id: 'replace-event', pass: events.some((e) => e.kind === 'superseded' && e.lesson === 'dev-port-3000'), detail: events.map((e) => `${e.kind}:${e.lesson}`).join(',') }];
    } },
  { key: 'retire', changes: ['mailhog-check'], prompt: 'Забудь урок про mailhog — мы убрали его со стенда, он больше не нужен.',
    grade: ({ meta, events, exists }) => [
      { id: 'retired', pass: meta('mailhog-check').status === 'retired', detail: `статус: ${meta('mailhog-check').status}` },
      { id: 'kept-in-archive', pass: exists('mailhog-check'), detail: 'файл урока удалён — отставка не удаление' },
      { id: 'retire-event', pass: events.some((e) => e.kind === 'retired' && e.lesson === 'mailhog-check'), detail: events.map((e) => `${e.kind}:${e.lesson}`).join(',') }] },
  { key: 'when', changes: ['prettier-write'], prompt: 'Триггер урока про prettier не ловит короткий флаг: `npx prettier -w src/` прошёл мимо. '
      + 'Поправь у урока when, чтобы ловил и `-w`, и `--write`, но не `--check`.',
    grade: ({ meta, compileWhen }) => {
      const w = compileWhen(meta('prettier-write').when || []);
      const fires = (cmd) => w.items.some((it) => (!it.tool || it.tool.test('Bash')) && (!it.cmd || it.cmd.test(cmd)) && !it.path && !it.body && !it.out);
      return [
        { id: 'when-compiles', pass: !w.problems.length && w.items.length > 0, detail: w.problems.join('; ') || `${w.items.length} элементов` },
        { id: 'when-catches', pass: fires('npx prettier -w src/') && fires('npx prettier --write src/a.ts'), detail: 'не ловит -w или --write' },
        { id: 'when-quiet', kind: 'quiet', pass: !fires('npx prettier --check src/'), detail: 'ловит --check' }];
    } },
];

// Tool errors in the transcript; «escaping» ones — shell quoting, heredoc, a regex. An Edit that missed its text counts
// only when that text carried escapes (\, quotes, backticks, $): a miss on plain words is an ordinary miss.
const ESCAPING = /unexpected EOF|unterminated|unexpected token|syntax error|bad substitution|unmatched|SyntaxError|Invalid regular expression/i;
const EDIT_MISS = /String to replace not found|old_string/i;
function toolErrors(events) {
  const out = [];
  const uses = new Map();
  for (const e of events || []) {
    if (!e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'tool_use') uses.set(b.id, b);
      if (e.type !== 'user' || b.type !== 'tool_result' || !b.is_error) continue;
      const text = (typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n')).slice(0, 300);
      const use = uses.get(b.tool_use_id);
      const escaping = ESCAPING.test(text)
        || (EDIT_MISS.test(text) && /[\\`'"$]/.test(String((use && use.input && use.input.old_string) || '')));
      out.push({ text, escaping });
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

function gradeTask(task, { run, ctx }) {
  const lib = (m) => require(path.join(ctx.hub, 'plugin', 'lib', 'memory', m));
  const { parseLesson, validateLesson, compileWhen } = lib('format.cjs');
  const { readEvents } = lib('events.cjs');
  const now = snapshot(ctx.mem);
  const meta = (id) => (now[rel(id)] ? parseLesson(now[rel(id)]).meta : {});
  const text = (id) => now[rel(id)] || '';
  const exists = (id) => rel(id) in now;
  const added = Object.keys(now).filter((p) => !(p in ctx.before)).map((p) => ({ id: path.basename(p, '.md'), text: now[p], meta: parseLesson(now[p]).meta }));
  const { events, problems: evProblems } = readEvents(ctx.mem);
  const invalid = Object.entries(now).flatMap(([p, t]) => validateLesson(Buffer.from(t), { file: `memory/${p}` }).map((x) => `${p}: ${x}`));
  const allowed = new Set(task.changes.map(rel));
  const touched = Object.keys(ctx.before).filter((p) => now[p] !== ctx.before[p] && !allowed.has(p));
  const errs = toolErrors(run.events);
  const escaping = errs.filter((e) => e.escaping).map((e) => e.text);
  const result = [...(run.events || [])].reverse().find((e) => e.type === 'result') || {};
  const u = result.usage || {};
  const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  return [
    ...task.grade({ meta, text, exists, added, events, compileWhen }).map((c) => ({ source: SRC, ...c })),
    { id: 'memory-valid', source: SRC, pass: invalid.length === 0 && evProblems.length === 0, detail: [...invalid, ...evProblems].slice(0, 3).join('; ') },
    { id: 'others-untouched', kind: 'quiet', source: SRC, pass: touched.length === 0, detail: `тронуты не те уроки: ${touched.join(', ')}` },
    { id: 'no-escaping-errors', kind: 'never', source: SRC, pass: escaping.length === 0, detail: escaping.slice(0, 2).join(' | ') },
    { id: 'tool-errors', observe: true, source: SRC, pass: errs.length === 0, detail: `ошибок инструментов ${errs.length}: ${errs.slice(0, 2).map((e) => e.text).join(' | ')}` },
    { id: 'tokens', observe: true, source: SRC, pass: true,
      detail: `токены ${tokens} (вход ${u.input_tokens || 0}, кэш ${(u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)}, выход ${u.output_tokens || 0}), ${run.turns} ходов` },
  ];
}

module.exports = TASKS.map((task) => ({
  id: `M11-${task.key}`, level: 'model', mech: 'memory-keeper', title: `Агент ухода за памятью: ${task.key} (тест 5)`, task,
  async setup({ base, work }) {
    const files = Object.fromEntries(Object.entries(LESSONS).map(([id, t]) => [rel(id), t]));
    const { hub, proj } = makeHub(base, work, { memory: files });
    const repo = path.join(proj, 'repo');
    gitRepo(repo, { 'apps/web/package.json': '{ "name": "web", "private": true }\n' });
    const mem = path.join(proj, 'memory');
    return { cwd: repo, hubDir: hub, prompt: task.prompt, maxTurns: 14, timeoutSec: 600,
      ctx: { mem, hub, before: snapshot(mem) } };
  },
  async grade({ run, ctx }) { return gradeTask(task, { run, ctx }); },
}));
module.exports.toolErrors = toolErrors;
