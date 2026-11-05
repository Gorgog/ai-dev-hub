#!/usr/bin/env node
// episode — wind-down writes an episode into memory v2 of a hub project; the library is plugin/lib/memory/.
//   episode.cjs [--memory <dir>] add <draft.md> [--new] [--user-said]   a new episode (lesson file) + its v1 line
//   episode.cjs repeat <id> --note <что было>                           the same thing again: event + v1 line
// Rule 7 of the hub: an episode always, a rule by repeat. A first episode is `kind: knowledge`; `kind: rule` right
// away only with --user-said; class «once» (`kind: once`) at once. A draft close to a lesson already there is not
// written — it is a repeat (or --new after reading both). Double write: while the project keeps its v1 errors.md, each
// episode is also one line there — for a new lesson the line `recall export-v1` gives it. The draft is written by the
// agent with Write (never heredoc: quotes, backticks and ${} break in Bash); this script writes the memory.
// A project without memory/lessons/ keeps the v1 way: said so, code 0, nothing written. Codes: 0 done, 1 refused, 2 usage.
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../../../lib/memory/store.cjs');
const { parseLesson } = require('../../../lib/memory/format.cjs');
const { overlap, wordsOf, MIN_OVERLAP } = require('../../memory-gc/scripts/gc.cjs');

const USAGE = 'команды: add <черновик.md> [--new] [--user-said] · repeat <id> --note <что было>';
const V1_WAY = 'памяти нового формата нет: в проекте нет memory/lessons/ — эпизод пиши по-старому, записью в memory/errors.md '
  + '(формат — в шапке файла; Edit или Write, не heredoc)';

function parse(argv) {
  const a = { _: [], memory: null, note: undefined, fresh: false, userSaid: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--memory') a.memory = argv[++i];
    else if (k === '--note') a.note = argv[++i];
    else if (k === '--new') a.fresh = true;
    else if (k === '--user-said') a.userSaid = true;
    else a._.push(k);
  }
  return a;
}

function where(a) {
  const dir = a.memory || process.env.HUB_MEMORY_DIR;
  if (dir) return { dir: path.resolve(dir), newFormat: fs.existsSync(path.join(path.resolve(dir), 'lessons')) };
  return S.memoryDir(process.cwd());
}

const who = (a) => ({ session_id: process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || undefined, mode: 'wind-down',
  ...(a.note !== undefined ? { note: a.note } : {}) });
const refuse = (msg) => Object.assign(new Error(msg), { code: 1 });

// One line onto the end of errors.md in one write on an O_APPEND descriptor: a neighbour session's line is never lost;
// a file without a final newline is closed first in the same write.
function appendV1(mem, line) {
  const fd = fs.openSync(path.join(mem, 'errors.md'), 'a+');
  try {
    let buf = Buffer.from(`${line}\n`);
    const size = fs.fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) buf = Buffer.concat([Buffer.from('\n'), buf]);
    }
    fs.writeSync(fd, buf);
  } finally { fs.closeSync(fd); }
}

// The v1 record of one lesson exactly as the library's export gives it.
function v1Line(mem, id) {
  const tail = new RegExp(`, урок ${id}(, [a-z]+)?\\)$`);
  const line = S.exportV1(mem)['errors.md'].split('\n').find((l) => tail.test(l));
  if (!line) throw new Error(`экспорт v1 не дал строки урока ${id}`);
  return line;
}

function add(mem, file, a) {
  const text = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseLesson(text);
  const id = String(meta.id || '');
  if (meta.kind === 'rule' && !a.userSaid) {
    throw refuse(`${id}: правило — по повтору (правило 7). Первый эпизод — kind: knowledge; сразу правило — класс «одного раза» `
      + '(kind: once: данные, права, деньги, пуш и внешние действия, .env и секреты, миграции) или по слову пользователя (--user-said)');
  }
  // Nearest lessons by the search, with their share of common words: at the bar — refused as a repeat; below it —
  // named after the write, since the same thing in other words shares few words (the agent reads and decides).
  const mine = wordsOf(meta, body);
  const nearest = S.similar(mem, file, { top: 3 }).hits
    .filter((h) => h.dir === 'lessons' && h.id !== id)
    .map((h) => {
      const p = parseLesson(fs.readFileSync(h.file, 'utf8'));
      return { h, j: overlap(mine, wordsOf(p.meta, p.body)) };
    });
  const line = ({ h, j }) => `- ${h.id} (общих слов ${Math.round(j * 100)} %): ${h.first}`;
  const near = nearest.filter((x) => x.j >= MIN_OVERLAP);
  if (!a.fresh && near.length) {
    throw refuse([`${id}: черновик похож на урок, который уже есть — это повтор, а не новый эпизод:`, ...near.map(line),
      `Повтор: episode.cjs repeat ${near[0].h.id} --note '<что было>'. Прочитал оба и это разное — add … --new.`].join('\n'));
  }
  const r = S.addLesson(mem, text);
  if (!r.ok) throw refuse(`${id || path.basename(file)}: урок не записан — ${r.problems.join('; ')}`);
  appendV1(mem, v1Line(mem, r.id));
  const out = [`эпизод ${r.id} записан: ${r.file} + строка в errors.md`];
  if (nearest.length && !near.length) {
    out.push(`ближайшие уроки (ниже порога похожести) — прочитай. Это то же другими словами — значит повтор: `
      + `recall.cjs merge ${r.id} <старый> и episode.cjs repeat <старый> --note '<что было>':`, ...nearest.map(line));
  }
  if (meta.kind === 'once') {
    out.push('класс «одного раза»: это механизм, в отставку не уходит — в заметку «Кандидат в механизм»: триггер `when` урока, '
      + 'правило rules.json или модуль хука, который не даст повторить');
  }
  return out.join('\n');
}

function repeat(mem, id, a) {
  if (!a.note) throw Object.assign(new Error(`repeat: нужна --note "<что было>"\n${USAGE}`), { code: 2 });
  const w = S.why(mem, id); // throws for an unknown id
  S.repeat(mem, id, who(a));
  const first = w.lesson.body.find((l) => l.trim()) || '';
  const note = a.note.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, ''); // one v1 record line, whatever the note held
  appendV1(mem, `- Повтор: ${note}. ${first} (${new Date().toISOString().slice(0, 10)}, урок ${id}, повтор)`);
  const n = w.events.filter((e) => e.kind === 'repeat').length + 1;
  const kind = w.lesson.meta.kind;
  const out = [`повтор ${id} записан (повторов ${n}) + строка в errors.md`];
  if (kind === 'knowledge') {
    out.push(`${n + 1}-й эпизод: урок становится правилом — Edit ${w.file}: kind: rule и триггер when (поля tool, cmd, path, body, out), `
      + 'по которому хук подаст его в момент ошибки. Вместо нового текста — кандидат-правка механизма в заметку.');
  } else {
    out.push(`правило уже есть и повторилось (${n}): текст не держит — в заметку «Кандидат в механизм»: точнее when, `
      + 'deny-once, правило rules.json или модуль хука.');
  }
  return out.join('\n');
}

function main(argv) {
  const a = parse(argv);
  const [cmd, arg] = a._;
  if (!['add', 'repeat'].includes(cmd)) throw Object.assign(new Error(cmd ? `неизвестная команда ${cmd}\n${USAGE}` : USAGE), { code: 2 });
  if (!arg) throw Object.assign(new Error(`${cmd}: не хватает аргумента\n${USAGE}`), { code: 2 });
  const m = where(a);
  if (!m) throw Object.assign(new Error('не в проекте хаба (projects/<имя>/…): укажи --memory <папка memory>'), { code: 2 });
  if (!m.newFormat) return V1_WAY;
  return cmd === 'add' ? add(m.dir, path.resolve(arg), a) : repeat(m.dir, arg, a);
}

if (require.main === module) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (e) {
    process.stderr.write(`episode: ${e.message}\n`);
    process.exitCode = e.code === 2 ? 2 : 1;
  }
}

module.exports = { main };
