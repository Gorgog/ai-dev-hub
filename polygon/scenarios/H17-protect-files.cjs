// protect-files: правка существующего .env, локфайла и миграции, уже лежащей в HEAD, — deny с причиной; чтение,
// новый файл, текст про них — тишина. Стенд (репозиторий проекта со всем этим и canary.json на механизмы среза 13)
// общий для H17–H21: fixture() ниже.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeHub, gitRepo } = require('../lib/hub.cjs');
const { realCorpus } = require('../lib/corpus.cjs');
const { runEvent, preToolVerdict } = require('../lib/hooks.cjs');

const PROTECT = ['protect-files', 'inline-script', 'agent-model', 'agent-roles'];

function fixture(base, work) {
  const { hub, proj } = makeHub(base, work, { extra: { 'canary.json': JSON.stringify({ mechanisms: PROTECT }) } });
  const repo = path.join(proj, 'repo');
  gitRepo(repo, {
    '.env': 'DB_URL=postgres://synthetic\n', '.env.local': 'X=1\n', '.env.example': 'DB_URL=\n', 'package.json': '{}\n',
    'package-lock.json': '{}\n', 'prisma/migrations/20260101000000_init/migration.sql': 'create table a (id int);\n',
    'src/a.ts': 'export const a = 1;\n', 'src/a.test.ts': 'test("a", () => {});\n', 'notes.md': '# notes\n',
  });
  fs.writeFileSync(path.join(repo, 'prisma/migrations/20260102000000_draft.sql'), '-- новая, не в HEAD\n');
  return { hub, proj, repo };
}

// Case → PreToolUse event: relative file paths from the repo; <repo>, <hub>, <tmp> in commands and paths; transcript —
// records of the session journal, written to a file for transcript_path.
function event({ id, tool, input, agent_type, transcript }, { hub, repo, work }) {
  const sub = (s) => String(s).replace(/<repo>/g, repo).replace(/<hub>/g, hub).replace(/<tmp>/g, path.join(work, 'tmp'));
  const inp = JSON.parse(sub(JSON.stringify(input)));
  if (inp.file_path && !path.isAbsolute(inp.file_path)) inp.file_path = path.join(repo, inp.file_path);
  const ev = { hook_event_name: 'PreToolUse', session_id: 'eval', cwd: repo, tool_name: tool, tool_input: inp, ...(agent_type ? { agent_type } : {}) };
  if (transcript) {
    ev.transcript_path = path.join(work, 'tmp', `${String(id).replace(/[^\w.-]/g, '_')}.jsonl`);
    fs.mkdirSync(path.dirname(ev.transcript_path), { recursive: true });
    fs.writeFileSync(ev.transcript_path, transcript.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return ev;
}

// A catch passes only on the mechanism's own deny (its reason matching `must`, when given); quiet — no deny of any
// slice-13 mechanism.
function judge(mech, cases, { base, pluginDir, work }, must = null) {
  const fx = { ...fixture(base, work), work };
  return cases.map((c) => {
    const { verdict, reasons } = preToolVerdict(runEvent(pluginDir, 'PreToolUse', event(c, fx), { AI_DEV_HUB: fx.hub }));
    const ours = verdict === 'deny' && reasons.some((r) => r.includes(`Хаб (${mech})`) && (!must || must.test(r)));
    const anyOurs = verdict === 'deny' && reasons.some((r) => PROTECT.some((m) => r.includes(`Хаб (${m})`)));
    return { id: c.id, source: c.source, real: c.real, kind: c.expect ? 'catch' : 'quiet', pass: c.expect ? ours : !anyOurs,
      detail: `ждали ${c.expect ? 'deny' : 'тишину'}, вышло ${verdict}${reasons[0] ? ': ' + reasons[0].slice(0, 90) : ''}` };
  });
}

const cases = (corpus, id) => corpus.map(([cid, tool, input, expect, source, agent_type, transcript]) => ({ id: cid, tool, input, expect, source, agent_type, transcript }))
  .concat(realCorpus(id) || []);

const R4 = 'правило 4 хаба';
// [id, tool, input, expectDeny, source]
const CORPUS = [
  ['edit-env', 'Edit', { file_path: '.env', old_string: 'synthetic', new_string: 'x' }, true, R4],
  ['write-env-local', 'Write', { file_path: '.env.local', content: 'X=2\n' }, true, R4],
  ['edit-lock', 'Edit', { file_path: 'package-lock.json', old_string: '{}', new_string: '{ }' }, true, R4],
  ['edit-applied-migration', 'Edit', { file_path: 'prisma/migrations/20260101000000_init/migration.sql', old_string: 'int', new_string: 'bigint' }, true, `${R4}; полигон M08`],
  ['bash-append-env', 'Bash', { command: 'echo "SECRET=1" >> .env' }, true, R4],
  ['bash-sed-lock', 'Bash', { command: "sed -i 's/{}/{ }/' package-lock.json" }, true, R4],
  ['bash-rm-migration', 'Bash', { command: 'rm prisma/migrations/20260101000000_init/migration.sql' }, true, R4],
  ['bash-cp-over-env', 'Bash', { command: 'cp .env.example .env' }, true, R4],
  ['new-migration-write', 'Write', { file_path: 'prisma/migrations/20260103000000_add/migration.sql', content: 'alter table a add b int;\n' }, false, 'новая миграция — разрешена (план 13)'],
  ['draft-migration-edit', 'Edit', { file_path: 'prisma/migrations/20260102000000_draft.sql', old_string: '--', new_string: '-- ' }, false, 'на диске, но не в HEAD'],
  ['edit-env-example', 'Edit', { file_path: '.env.example', old_string: 'DB_URL=', new_string: 'DB_URL=\nX=' }, false, 'образец без секретов'],
  ['new-env-write', 'Write', { file_path: 'apps/api/.env', content: 'X=1\n' }, false, 'нового .env ещё нет'],
  ['read-env', 'Bash', { command: 'grep -c . .env && ls apps/backend/.env.test 2>/dev/null' }, false, 'чтение'],
  ['commit-lock', 'Bash', { command: 'git add package-lock.json && git commit -m "lock после npm install"' }, false, 'коммит локфайла — не правка'],
  ['commit-msg-env', 'Bash', { command: 'git commit -m "не писать > .env руками"' }, false, 'текст сообщения'],
  ['heredoc-text-env', 'Bash', { command: "cat >> notes.md <<'EOF'\nрецепт: echo X >> .env — нельзя\nEOF" }, false, 'текст урока в heredoc'],
  ['edit-src', 'Edit', { file_path: 'src/a.ts', old_string: '1', new_string: '2' }, false, 'обычная правка'],
];

module.exports = {
  id: 'H17', level: 'hook', mech: 'protect-files', title: 'protect-files: .env, локфайлы, применённые миграции', CORPUS,
  fixture, event, judge, cases, PROTECT,
  async run(ctx) { return judge('protect-files', cases(CORPUS, 'H17'), ctx); },
};
