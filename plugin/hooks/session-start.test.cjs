// node --test session-start.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildBrief, BUDGET } = require('./session-start.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

function project() {
  const hub = tmp();
  const p = path.join(hub, 'projects', 'demo');
  const repo = path.join(p, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  write(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-q', '-m', 'x');
  git('switch', '-q', '-c', 'K-7');
  write(path.join(repo, 'b.txt'), 'new');
  write(path.join(p, 'memory', 'errors-index.md'), '# Индекс\n- правило один\n- правило два\n');
  write(path.join(p, 'memory', 'sessions', '2026-10-01-k-7-old.md'), '# K-7 старое\n## Дальше\nстарое\n');
  write(path.join(p, 'memory', 'sessions', '2026-10-05-k-7-review.md'), '# K-7 ревью\n## Сделано\nx\n## Дальше\n1. Добить тест\n');
  write(path.join(p, 'memory', 'sessions', '2026-10-06-other.md'), '# K-9\nрядом упомянута K-7 одной строкой\n## Дальше\nчужое\n');
  write(path.join(p, 'memory', 'sessions', '2026-10-07-k-7-2-next.md'), '# K-7-2 правка\n## Дальше\nсоседняя ветка\n');
  write(path.join(p, 'memory', 'sessions', '2026-10-08-main-rebase.md'), '# Ребейз main\n## Дальше\nпро ствол\n');
  write(path.join(p, 'dispatch-rules.json'), '{ broken');
  return { hub, p, repo };
}

test('brief: project, branch of repo/, changes, index, the latest note OF this branch, preflight warnings', () => {
  const { hub, repo } = project();
  const b = buildBrief(repo, hub);
  assert.match(b, /demo · ветка K-7 · изменённых 1/);
  assert.match(b, /правило два/);
  assert.match(b, /2026-10-05-k-7-review\.md/);
  assert.match(b, /Добить тест/);
  assert.doesNotMatch(b, /чужое|старое|соседняя ветка/);
  assert.match(b, /dispatch-rules\.json/);
  assert.ok(b.length <= BUDGET);
});

test('brief from the project folder itself: git of repo/, not of the hub', () => {
  const { hub, p } = project();
  assert.match(buildBrief(p, hub), /ветка K-7 · изменённых 1/);
});

test('brief: no note on main; a big index is cut to the budget with a pointer', () => {
  const { hub, p, repo } = project();
  execFileSync('git', ['switch', '-q', 'main'], { cwd: repo });
  write(path.join(p, 'memory', 'errors-index.md'), '# Индекс\n' + '- длинное правило про всё на свете\n'.repeat(1000));
  const b = buildBrief(repo, hub);
  assert.doesNotMatch(b, /Последняя заметка|про ствол/);
  assert.ok(b.length <= BUDGET, `length ${b.length}`);
  assert.match(b, /обрезан.*errors-index\.md/);
});

test('brief.json: chosen index sections in full, the others as one line each with their keys', () => {
  const { hub, p, repo } = project();
  write(path.join(p, 'memory', 'errors-index.md'), [
    '# Индекс', 'шапка',
    '## Git: коммиты — ключи: `git add`', '- правило гита', '',
    '## kubb и OpenAPI — ключи: `kubb generate`', '- ' + 'длинное правило kubb '.repeat(600), '',
    '## Шелл Windows — ключи: `heredoc`', '- правило шелла', '',
  ].join('\n'));
  write(path.join(p, 'brief.json'), JSON.stringify({ indexSections: ['Git', 'Шелл'] }));
  const b = buildBrief(repo, hub);
  assert.match(b, /правило гита/);
  assert.match(b, /правило шелла/);
  assert.doesNotMatch(b, /длинное правило kubb/);
  assert.match(b, /по касанию: kubb и OpenAPI — ключи: `kubb generate`/);
  assert.doesNotMatch(b, /обрезан/);
});

test('brief.json: when chosen sections and a long note do not fit, the last chosen sections become «по касанию» — nothing is cut', () => {
  const { hub, p, repo } = project();
  const big = (name) => [`## ${name} — ключи: \`${name}\``, '- ' + `правило ${name} `.repeat(220)].join('\n');
  write(path.join(p, 'memory', 'errors-index.md'), ['# Индекс', big('Git'), big('Шелл'), big('Мутации'), big('kubb')].join('\n\n'));
  write(path.join(p, 'brief.json'), JSON.stringify({ indexSections: ['Git', 'Шелл', 'Мутации'] }));
  write(path.join(p, 'memory', 'sessions', '2026-10-09-k-7-long.md'), '# K-7 длинная\n## Дальше\n' + 'шаг дальше '.repeat(130) + '\n');
  const b = buildBrief(repo, hub);
  assert.ok(b.length <= BUDGET, `length ${b.length}`);
  assert.doesNotMatch(b, /обрезан/);
  assert.match(b, /правило Git/);
  assert.match(b, /по касанию: Мутации/);
  assert.match(b, /по касанию: kubb/);
  assert.match(b, /шаг дальше/);
});

test('brief: silent outside a project of this hub', () => {
  const { hub } = project();
  assert.strictEqual(buildBrief(tmp(), hub), '');
  const other = path.join(tmp(), 'projects', 'app');
  fs.mkdirSync(other, { recursive: true });
  assert.strictEqual(buildBrief(other, hub), '');
});
