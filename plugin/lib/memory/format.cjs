// The lesson file of memory v2: `memory/lessons/<id>.md` (decisions — `memory/decisions/<id>.md`, the same format).
// Frontmatter is a small YAML subset read by hand, so an agent writes it with Write/Edit and no escaping at all:
//   id: bash-inline-script-to-file
//   kind: rule                      rule | once (class «одного раза»: never retired) | knowledge | decision
//   when:                           triggers: a block list; values are raw regexes (flag i), no quotes needed
//     - tool: ^Bash$                fields: tool, cmd, path, body, out (as in the memory prototype)
//       cmd: <<\s*'?EOF
//   keys: [heredoc, node -e]        flow `[a, b]` or a block list
//   status: active                  the layer: core (ядро) | active (по касанию) | retired | superseded (архив)
//   supersedes: []
//   source: модель (миграция)       starts with «пользователь», «модель» or «внешний»
//   created: 2026-09-19
// Then 2–5 lines of text, the first ≤ 160 characters — it is what gets delivered. No counters: they are events.
// validateLesson is the one check for the write hook (slice 21) and the migration (slice 23).
'use strict';
const path = require('path');

const FIELDS = ['id', 'kind', 'when', 'keys', 'status', 'supersedes', 'source', 'created'];
const LISTS = new Set(['when', 'keys', 'supersedes']);
const KINDS = ['rule', 'once', 'knowledge', 'decision'];
const STATUSES = ['core', 'active', 'retired', 'superseded'];
const SOURCES = ['пользователь', 'модель', 'внешний'];
const WHEN_FIELDS = ['tool', 'cmd', 'path', 'body', 'out'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
// A whole word: «пользовательский» is not «пользователь».
const SOURCE_RE = /^(?:пользователь|модель|внешний)(?=$|[\s(,.:;—-])/;
const realDate = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return /^\d{4}-\d\d-\d\d$/.test(String(s)) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const FIRST_MAX = 160;

const layer = (meta) => (meta.status === 'core' ? 'core' : meta.status === 'active' ? 'touch' : 'archive');

// A scalar as written; one pair of surrounding quotes is dropped as is (no unescaping: a regex stays a regex).
function scalar(s) {
  const t = s.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
}
function flow(s) {
  const inner = s.trim().slice(1, -1).trim();
  return inner ? inner.split(',').map(scalar) : [];
}

// text → {meta, body, problems}; meta has only the fields found, body — the lines after the frontmatter.
function parseLesson(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!m) return { meta: {}, body: [], problems: ['нет frontmatter (--- … ---) в начале файла'], frontmatter: false };
  const meta = {}, problems = [];
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*):(?:\s(.*))?$/);
    if (!kv) { problems.push(`строка frontmatter не разобрана: «${line.slice(0, 60)}»`); continue; }
    const [, key, rest = ''] = kv;
    if (key in meta) problems.push(`поле ${key} дважды`);
    const v = rest.trim();
    if (v.startsWith('[') && v.endsWith(']')) { meta[key] = flow(v); continue; }
    if (v) { meta[key] = scalar(v); continue; }
    // A block list: «  - value» items; an item «  - field: value» opens a mapping that «    field: value» goes on.
    const items = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      const l = lines[++i];
      const item = l.match(/^\s+-\s+(.*)$/);
      const cont = l.match(/^\s+([A-Za-z_]\w*):\s(.*)$/);
      if (item) {
        const f = item[1].match(/^([A-Za-z_]\w*):\s(.*)$/);
        items.push(f ? { [f[1]]: scalar(f[2]) } : scalar(item[1]));
      } else if (cont && items.length && typeof items[items.length - 1] === 'object') {
        items[items.length - 1][cont[1]] = scalar(cont[2]);
      } else problems.push(`строка списка ${key} не разобрана: «${l.slice(0, 60)}»`);
    }
    meta[key] = items;
  }
  const body = m[2].split('\n');
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return { meta, body, problems, frontmatter: true };
}

const flowOut = (a) => `[${(a || []).join(', ')}]`;
function formatLesson(meta, body) {
  const out = ['---'];
  for (const k of FIELDS) {
    const v = meta[k];
    if (k === 'when') {
      if (!v || !v.length) { out.push('when: []'); continue; }
      out.push('when:');
      for (const item of v) {
        Object.entries(item).forEach(([f, rx], j) => out.push(`${j ? '    ' : '  - '}${f}: ${rx}`));
      }
    } else if (LISTS.has(k)) out.push(`${k}: ${flowOut(v)}`);
    else out.push(`${k}: ${v == null ? '' : v}`);
  }
  out.push('---', ...body, '');
  return out.join('\n');
}

// [{field: regex}] → compiled items; a bad item is a problem naming when[i].field, the rest still compile.
function compileWhen(when) {
  const items = [], problems = [];
  (Array.isArray(when) ? when : []).forEach((w, i) => {
    if (!w || typeof w !== 'object') {
      problems.push(`when[${i}]: нужен блок полей ${WHEN_FIELDS.join('/')}, а не строка «${String(w).slice(0, 40)}»`);
      return;
    }
    const item = {};
    let ok = true;
    for (const [k, src] of Object.entries(w)) {
      if (!WHEN_FIELDS.includes(k)) { problems.push(`when[${i}]: неизвестное поле ${k} (есть ${WHEN_FIELDS.join(', ')})`); ok = false; continue; }
      try { item[k] = new RegExp(src, 'i'); } catch (e) { problems.push(`when[${i}].${k}: регэксп не компилируется — ${e.message}`); ok = false; }
    }
    if (!Object.keys(w).length) { problems.push(`when[${i}]: пустой элемент`); ok = false; }
    if (ok) items.push(item);
  });
  return { items, problems };
}

// Lessons are facts, not orders: text that would act (push, send, delete) or points outside (URL) is refused.
// `git` may carry global options before the subcommand (`git -C <dir> push` is the hub's own form); `rm` flags may
// come split or long (`rm -r -f`, `--recursive --force`).
const GIT = String.raw`\bgit(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;
const DANGER = [
  [new RegExp(`${GIT}push\\b`, 'i'), 'git push'],
  [new RegExp(`${GIT}reset\\s+--hard\\b`, 'i'), 'git reset --hard'],
  [new RegExp(`${GIT}clean\\s+-\\w*f`, 'i'), 'git clean -f'],
  [new RegExp(`${GIT}branch\\s+-D\\b`), 'git branch -D'],
  [/\brm\b(?=[^\n`;|&]*\s(?:-\w*r|--recursive\b))(?=[^\n`;|&]*\s(?:-\w*f|--force\b))/i, 'rm -rf'],
  [/\bcurl\b[^\n`]*\s(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|-d\b|--data\b|-F\b|--form\b|-T\b)/i, 'curl с отправкой'],
  [/\bwget\b[^\n`]*--(?:post-(?:data|file)|method[= ](?:POST|PUT|PATCH|DELETE))/i, 'wget с отправкой'],
  [/\b(?:gh|glab)\s+(?:pr|mr|release|issue|repo)\s+(?:create|merge|close|delete|edit)\b/i, 'gh/glab create|merge|delete'],
  [/\bnpm\s+publish\b/i, 'npm publish'],
  [/\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i, 'DROP/TRUNCATE'],
  [/\bdropdb\b/i, 'dropdb'],
  [/\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+rm)\b/i, 'docker rm'],
  [/\b(?:sendmail|mail\s+-s)\b/i, 'отправка почты'],
];
const URL_RE = /\b(?:https?|ftp):\/\/|\bwww\.[a-z0-9-]+\./i;

// Buffer (or string) of a lesson file → problems, [] when valid. opts.file — its path: the id must match the file
// name, and memory/decisions/ holds kind decision only.
function validateLesson(buf, { file } = {}) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  const problems = [];
  const nul = raw.indexOf(0);
  if (nul >= 0) problems.push(`NUL-байт в файле (строка ${raw.subarray(0, nul).toString('latin1').split('\n').length}): grep пропустит файл`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch {
    problems.push('файл не в UTF-8');
    text = raw.toString('utf8');
  }
  const { meta, body, problems: parse, frontmatter } = parseLesson(text.replace(/\u0000/g, ''));
  problems.push(...parse);
  if (!frontmatter) return problems;
  for (const k of FIELDS) if (!(k in meta)) problems.push(`нет поля ${k}`);
  for (const k of Object.keys(meta)) if (!FIELDS.includes(k)) problems.push(`лишнее поле ${k}: счётчики и прочее — событиями, не в уроке`);
  for (const k of FIELDS) {
    if (!(k in meta)) continue;
    if (LISTS.has(k) !== Array.isArray(meta[k])) problems.push(LISTS.has(k) ? `${k}: нужен список` : `${k}: нужно значение, не список`);
  }
  if (typeof meta.id === 'string') {
    if (!ID_RE.test(meta.id)) problems.push(`id «${meta.id}»: только a-z, 0-9 и дефис, до 80 знаков`);
    if (file && path.basename(file, '.md') !== meta.id) problems.push(`id «${meta.id}» не совпадает с именем файла ${path.basename(file)}`);
  }
  if ('kind' in meta && !KINDS.includes(meta.kind)) problems.push(`kind «${meta.kind}»: нужен один из ${KINDS.join(', ')}`);
  if ('status' in meta && !STATUSES.includes(meta.status)) problems.push(`status «${meta.status}»: нужен один из ${STATUSES.join(', ')}`);
  if ('created' in meta && !realDate(meta.created)) problems.push(`created «${meta.created}»: нужна дата ГГГГ-ММ-ДД`);
  if ('source' in meta && !SOURCE_RE.test(String(meta.source))) {
    problems.push(`source «${meta.source}»: начинается с одного из ${SOURCES.join(', ')}`);
  }
  if (String(meta.source || '').startsWith('внешний') && (['rule', 'once'].includes(meta.kind) || meta.status === 'core')) {
    problems.push('source «внешний»: внешний текст сам правилом не становится (kind knowledge, не ядро)');
  }
  if (file) {
    const inDecisions = /(^|[\\/])decisions[\\/][^\\/]+$/.test(file);
    if (inDecisions && meta.kind !== 'decision') problems.push('в memory/decisions/ — только kind decision');
    if (!inDecisions && meta.kind === 'decision') problems.push('kind decision — в memory/decisions/, не в уроках');
  }
  if (Array.isArray(meta.supersedes)) {
    for (const s of meta.supersedes) if (!ID_RE.test(s)) problems.push(`supersedes: «${s}» — не id урока`);
  }
  if (Array.isArray(meta.when)) problems.push(...compileWhen(meta.when).problems);
  if (body.length < 2 || body.length > 5) problems.push(`текст урока — 2–5 строк, а их ${body.length}`);
  if (body.length && !body[0].trim()) problems.push('первая строка текста пустая: подаётся именно она — убери пустую строку после ---');
  if (body.length && [...body[0]].length > FIRST_MAX) problems.push(`первая строка — ${[...body[0]].length} знаков (лимит ${FIRST_MAX})`);
  const prose = [...body, ...(Array.isArray(meta.keys) ? meta.keys : [])].join('\n');
  if (URL_RE.test(prose)) problems.push('URL в тексте урока: урок — факт, не ссылка наружу');
  for (const [re, name] of DANGER) {
    if (re.test(prose)) problems.push(`команда пуша/отправки/удаления в тексте урока (${name}): урок — факт, не приказ`);
  }
  return problems;
}

module.exports = { parseLesson, formatLesson, validateLesson, compileWhen, layer, FIELDS, KINDS, STATUSES, SOURCES,
  WHEN_FIELDS, FIRST_MAX };
