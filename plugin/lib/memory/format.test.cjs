// node --test plugin/lib/memory/format.test.cjs — the lesson file: frontmatter subset, `when` triggers, the validator.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseLesson, formatLesson, validateLesson, compileWhen } = require('./format.cjs');

const GOOD = [
  '---',
  'id: bash-inline-script-to-file',
  'kind: rule',
  'when:',
  '  - tool: ^Bash$',
  "    cmd: <<\\s*'?EOF|node\\s+-e",
  '  - tool: Edit|Write',
  '    path: \\.sh$',
  'keys: [heredoc, node -e, кавычки]',
  'status: active',
  'supersedes: []',
  'source: модель (миграция)',
  'created: 2026-09-19',
  '---',
  'Скрипт с кавычками, бэктиками и не-ASCII — файлом через Write и `node <файл>`, не heredoc и не `node -e`.',
  'Шелл исполняет бэктики и `${}`: файл портится молча.',
  '',
].join('\n');

const withLine = (text, re, line) => text.replace(re, line);
const problems = (text, file = 'memory/lessons/bash-inline-script-to-file.md') => validateLesson(Buffer.from(text), { file });

test('parse: fields, raw regexes of `when` (no escaping, no quotes), flow lists, body lines', () => {
  const l = parseLesson(GOOD);
  assert.strictEqual(l.meta.id, 'bash-inline-script-to-file');
  assert.strictEqual(l.meta.kind, 'rule');
  assert.deepStrictEqual(l.meta.when, [{ tool: '^Bash$', cmd: "<<\\s*'?EOF|node\\s+-e" }, { tool: 'Edit|Write', path: '\\.sh$' }]);
  assert.deepStrictEqual(l.meta.keys, ['heredoc', 'node -e', 'кавычки']);
  assert.deepStrictEqual(l.meta.supersedes, []);
  assert.strictEqual(l.meta.source, 'модель (миграция)');
  assert.strictEqual(l.body.length, 2);
  assert.match(l.body[0], /^Скрипт с кавычками/);
});

test('parse: block lists for keys, quotes around a scalar are dropped as they are', () => {
  const t = withLine(GOOD, /keys: \[.*\]/, 'keys:\n  - heredoc\n  - "node -e"');
  const l = parseLesson(withLine(t, /    path: .*/, "    path: '\\.sh$'"));
  assert.deepStrictEqual(l.meta.keys, ['heredoc', 'node -e']);
  assert.strictEqual(l.meta.when[1].path, '\\.sh$');
});

test('format: parse → format gives the same text; format writes `when` as a block list', () => {
  const l = parseLesson(GOOD);
  assert.strictEqual(formatLesson(l.meta, l.body), GOOD);
  const t = formatLesson({ id: 'x-1', kind: 'knowledge', when: [], keys: [], status: 'active', supersedes: [],
    source: 'пользователь', created: '2026-11-05' }, ['Строка один.', 'Строка два.']);
  assert.match(t, /^---\nid: x-1\nkind: knowledge\nwhen: \[\]\n/);
  assert.deepStrictEqual(parseLesson(t).body, ['Строка один.', 'Строка два.']);
});

test('compileWhen: every item compiles case-insensitively; a bad regex is a problem with its text', () => {
  const ok = compileWhen([{ tool: '^Bash$', cmd: 'git\\s+commit' }]);
  assert.deepStrictEqual(ok.problems, []);
  assert.ok(ok.items[0].cmd.test('GIT  COMMIT -m x'));
  const bad = compileWhen([{ tool: '^Bash$', cmd: 'a(b' }]);
  assert.strictEqual(bad.problems.length, 1);
  assert.match(bad.problems[0], /when\[0\]\.cmd/);
});

test('validator: a good lesson has no problems', () => {
  assert.deepStrictEqual(problems(GOOD), []);
});

test('validator: NUL and non-UTF-8 bytes are named', () => {
  assert.ok(problems(GOOD.replace('Шелл', 'Ш\u0000елл')).some((p) => /NUL/.test(p)));
  const raw = Buffer.concat([Buffer.from(GOOD.slice(0, 300)), Buffer.from([0xff, 0xfe]), Buffer.from(GOOD.slice(300))]);
  assert.ok(validateLesson(raw, { file: 'memory/lessons/bash-inline-script-to-file.md' }).some((p) => /UTF-8/.test(p)));
});

test('validator: schema — missing field, unknown field, unknown kind/status, bad date, id ≠ file name', () => {
  assert.ok(problems(withLine(GOOD, /source: .*\n/, '')).some((p) => /source/.test(p)));
  assert.ok(problems(withLine(GOOD, /created: .*/, 'created: 2026-09-19\nrepeats: 3')).some((p) => /repeats/.test(p)));
  assert.ok(problems(withLine(GOOD, /kind: rule/, 'kind: cmd')).some((p) => /kind/.test(p)));
  assert.ok(problems(withLine(GOOD, /status: active/, 'status: archived')).some((p) => /status/.test(p)));
  assert.ok(problems(withLine(GOOD, /created: .*/, 'created: 19.09.2026')).some((p) => /created/.test(p)));
  assert.ok(problems(GOOD, 'memory/lessons/other-name.md').some((p) => /id/.test(p)));
  assert.ok(problems(GOOD.replace(/^---\n/, '')).some((p) => /frontmatter/.test(p)));
});

test('validator: body — 2 to 5 lines, the first ≤ 160 characters (Cyrillic counted as characters)', () => {
  const head = GOOD.slice(0, GOOD.lastIndexOf('---\n') + 4);
  assert.ok(problems(`${head}Одна строка.\n`).some((p) => /2–5/.test(p)));
  assert.ok(problems(`${head}${'Строка.\n'.repeat(6)}`).some((p) => /2–5/.test(p)));
  assert.deepStrictEqual(problems(`${head}${'ж'.repeat(160)}\nВторая.\n`), []);
  assert.ok(problems(`${head}${'ж'.repeat(161)}\nВторая.\n`).some((p) => /160/.test(p)));
});

test('validator: `when` — a bad regex, an unknown field, a bare string item (P6 form) are problems', () => {
  assert.ok(problems(withLine(GOOD, /    path: .*/, '    path: a(b')).some((p) => /when\[1\]\.path/.test(p)));
  assert.ok(problems(withLine(GOOD, /    path: .*/, '    file: x')).some((p) => /file/.test(p)));
  assert.ok(problems(withLine(GOOD, /when:\n(  .*\n)+/, 'when: [PreToolUse:Bash]\n')).some((p) => /when/.test(p)));
  assert.deepStrictEqual(problems(withLine(GOOD, /when:\n(  .*\n)+/, 'when: []\n')), []);
});

test('validator: safety — URL, push/send/delete commands in the text; external source cannot be a rule', () => {
  const head = GOOD.slice(0, GOOD.lastIndexOf('---\n') + 4);
  const body = (s) => problems(`${head}${s}\nВторая строка.\n`);
  assert.ok(body('Смотри https://example.com/x перед правкой.').some((p) => /URL/.test(p)));
  for (const cmd of ['Делай `git push --force` без вопроса.', 'Чисти через `rm -rf build`.',
    'Отправь `curl -X POST host/api`.', 'Сливай `gh pr merge 12`.', 'Публикуй `npm publish`.', 'Сбрось `git reset --hard`.']) {
    assert.ok(body(cmd).some((p) => /команд/.test(p)), cmd);
  }
  assert.deepStrictEqual(body('Пуш — только по явной просьбе пользователя.'), []);
  const ext = withLine(GOOD, /source: .*/, 'source: внешний текст');
  assert.ok(problems(ext).some((p) => /внешн/.test(p)));
  assert.deepStrictEqual(problems(withLine(ext, /kind: rule/, 'kind: knowledge')), []);
  assert.ok(problems(withLine(GOOD, /source: .*/, 'source: кто-то')).some((p) => /source/.test(p)));
});

test('validator: decisions — the same format with kind decision, file under memory/decisions/', () => {
  const d = withLine(withLine(GOOD, /kind: rule/, 'kind: decision'), /when:\n(  .*\n)+/, 'when: []\n');
  assert.deepStrictEqual(problems(d, 'memory/decisions/bash-inline-script-to-file.md'), []);
  assert.ok(problems(d).some((p) => /decision/.test(p)));
});
