// node --test skills-layout.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILLS = __dirname;
const DIR_VAR = '${CLAUDE_SKILL_DIR}';

// Hub scripts: files in plugin/skills/*/scripts/ and plugin/hooks/ (a project's own snippet is not one).
const PLUGIN = path.join(SKILLS, '..');
const HUB_SCRIPTS = new Set([
  ...fs.readdirSync(SKILLS).flatMap((d) => {
    const dir = path.join(SKILLS, d, 'scripts');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }),
  ...fs.readdirSync(path.join(PLUGIN, 'hooks')),
]);

// Script paths in a SKILL.md: Claude Code substitutes ${CLAUDE_SKILL_DIR} with the skill's own folder (the plugin
// cache in a live install), so a skill finds its scripts from any working folder. A path from the hub root
// (`<хаб>/plugin/…`), a bare `dispatch/scripts/…` or `node x.cjs` without a folder only works from one place.
function scriptPathProblems(text, skillDir) {
  const out = [];
  const hubRoot = new Set([...text.matchAll(/<хаб>\/plugin\/[^\s`'"]*/g)].map((m) => m[0]));
  for (const p of hubRoot) out.push(`путь от корня хаба: ${p}`);
  const seen = new Set();
  const scriptRe = /[^\s`'"(]*(?:scripts|hooks)\/[\w.-]+\.(?:c?js|mjs|sh)\b/g;
  const runRe = /\b(?:node(?:\s+--test)?|bash)\s+([^\s`'"]+\.(?:c?js|mjs|sh))\b/g;
  const paths = [...[...text.matchAll(scriptRe)].map((m) => m[0]), ...[...text.matchAll(runRe)].map((m) => m[1])];
  for (const p of paths) {
    if (seen.has(p) || !HUB_SCRIPTS.has(path.basename(p))) continue;
    seen.add(p);
    if (p.startsWith('<хаб>/')) continue; // already reported above
    if (!p.startsWith(DIR_VAR + '/')) { out.push(`скрипт мимо ${DIR_VAR}: ${p}`); continue; }
    if (!fs.existsSync(path.join(skillDir, p.slice(DIR_VAR.length + 1)))) out.push(`нет файла: ${p}`);
  }
  return out;
}

test('script paths: hub-root, bare and folderless script paths are problems; ${CLAUDE_SKILL_DIR} paths must exist', () => {
  const dir = path.join(SKILLS, 'checks');
  const text = [
    'node <хаб>/plugin/skills/checks/scripts/checks.cjs --full',
    'каждый шаг — через `dispatch/scripts/hub-run.sh`',
    'Тест: `node --test checks.test.cjs`',
    'node ${CLAUDE_SKILL_DIR}/scripts/checks.cjs',
    'node ${CLAUDE_SKILL_DIR}/../nope/scripts/checks.cjs',
    'node ${CLAUDE_SKILL_DIR}/../../hooks/journal-summary.cjs',
    '`hub-run.sh --stop <worktree>`, папка `scripts/` рядом, сниппет проекта `node {project}/memory/snippets/x.cjs`',
  ].join('\n');
  assert.deepStrictEqual(scriptPathProblems(text, dir), [
    'путь от корня хаба: <хаб>/plugin/skills/checks/scripts/checks.cjs',
    'скрипт мимо ${CLAUDE_SKILL_DIR}: dispatch/scripts/hub-run.sh',
    'нет файла: ${CLAUDE_SKILL_DIR}/../nope/scripts/checks.cjs',
    'скрипт мимо ${CLAUDE_SKILL_DIR}: checks.test.cjs',
  ]);
});

test('every SKILL.md reaches hub scripts only through ${CLAUDE_SKILL_DIR}', () => {
  const skills = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')));
  assert.ok(skills.length >= 9, `скиллов: ${skills.length}`);
  const problems = skills.flatMap((d) =>
    scriptPathProblems(fs.readFileSync(path.join(SKILLS, d, 'SKILL.md'), 'utf8'), path.join(SKILLS, d)).map((p) => `${d}: ${p}`));
  assert.deepStrictEqual(problems, []);
});

// dispatch/SKILL.md is split into topic files: steps stay in SKILL.md, each topic has its own file for the slices
// that change it. The split moves text, it does not rewrite it.
const DISPATCH = 'plugin/skills/dispatch';
const TOPICS = ['state.md', 'resources.md', 'questions.md', 'push.md'];
const TOC = '## Когда что читать';
const BEFORE = 'ef519e3'; // main before the split (slice 05 base)

test('dispatch: SKILL.md has a «when to read what» table naming every topic file, and the topic files exist', () => {
  const skill = fs.readFileSync(path.join(SKILLS, 'dispatch', 'SKILL.md'), 'utf8');
  const toc = tocBlock(skill.split('\n'));
  assert.ok(toc.length > 0, `в SKILL.md нет раздела «${TOC.slice(3)}»`);
  for (const f of TOPICS) {
    assert.ok(fs.existsSync(path.join(SKILLS, 'dispatch', f)), `нет файла dispatch/${f}`);
    assert.ok(toc.some((l) => l.includes('`' + f + '`')), `оглавление не называет ${f}`);
  }
});

function tocBlock(lines) {
  const at = lines.findIndex((l) => l.trim() === TOC);
  if (at < 0) return [];
  const end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  return lines.slice(at, end < 0 ? lines.length : end);
}

function git(args) {
  return execFileSync('git', args, { cwd: SKILLS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// The check is about the split commit itself — the first commit after BEFORE that touches dispatch/SKILL.md — so
// later slices may edit the topic files freely. Lines are compared trimmed: a moved list item may lose its indent.
// The one rewritten line is the scripts path (`<хаб>/plugin/skills/dispatch/scripts/` → `${CLAUDE_SKILL_DIR}/scripts/`).
// New lines are allowed only in the table of contents: the «when to read what» block of SKILL.md, the title of a
// topic file and a `→ …` pointer to another file.
test('dispatch: the split loses no line of SKILL.md and adds only table-of-contents lines', (t) => {
  let split;
  try {
    git(['cat-file', '-e', `${BEFORE}^{commit}`]);
    split = git(['log', '--reverse', '--format=%H', `${BEFORE}..HEAD`, '--', `${DISPATCH}/SKILL.md`]).split('\n')[0];
  } catch {
    t.skip(`нет git или коммита ${BEFORE} (мелкий клон)`);
    return;
  }
  assert.ok(split, `после ${BEFORE} нет коммита, который разносит ${DISPATCH}/SKILL.md`);
  const show = (rev, f) => git(['show', `${rev}:${DISPATCH}/${f}`]);
  const norm = (l) => l.trim();
  const before = new Set(show(BEFORE, 'SKILL.md')
    .replace('<хаб>/plugin/skills/dispatch/scripts/', DIR_VAR + '/scripts/')
    .split('\n').map(norm).filter(Boolean));

  const after = new Set();
  const added = [];
  const skillLines = show(split, 'SKILL.md').split('\n');
  const toc = new Set(tocBlock(skillLines));
  for (const l of skillLines) {
    if (!norm(l)) continue;
    after.add(norm(l));
    if (!before.has(norm(l)) && !toc.has(l)) added.push(`SKILL.md: ${l}`);
  }
  for (const f of TOPICS) {
    show(split, f).split('\n').forEach((l, i) => {
      if (!norm(l)) return;
      after.add(norm(l));
      const tocLine = (i === 0 && l.startsWith('# ')) || norm(l).startsWith('→ ');
      if (!before.has(norm(l)) && !tocLine) added.push(`${f}: ${l}`);
    });
  }
  assert.deepStrictEqual([...before].filter((l) => !after.has(l)), [], 'потеряны строки');
  assert.deepStrictEqual(added, [], 'новые строки вне оглавления');
});
