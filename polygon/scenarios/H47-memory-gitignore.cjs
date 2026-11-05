// Срез 22: `.gitignore` шаблона памяти не пускает в git памяти выводимые файлы v2 — индекс FTS5 (`.index.db` и его
// `-wal`/`-shm`/`-journal`), `.triggers.json`, временные файлы атомарной записи (`*.tmp-*`, `.<урок>.md.tmp-*`), а
// источники истины — уроки, решения, события, `errors.md` — git видит. Проверка — настоящим git на копии шаблона.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = 'срез 22 / формат памяти v2 (14): выводимые .index.db, .triggers.json, *.tmp-* — не в git памяти';
const DERIVED = ['.index.db', '.index.db-wal', '.index.db-shm', '.index.db-journal', '.triggers.json', '.triggers.json.tmp-123-ab12cd',
  '.index.db.tmp-123-ab12cd', 'lessons/.dev-port.md.tmp-123-ab12cd', 'events/.2026-11.jsonl.tmp-9-ff'];
const SOURCES = ['lessons/dev-port.md', 'decisions/stack.md', 'events/2026-11.jsonl', 'errors.md', 'errors-index.md', 'decisions.md'];

module.exports = {
  id: 'H47', level: 'hook', mech: 'memory-skills', title: 'Память: .gitignore шаблона — выводимые файлы v2 не в git памяти',
  async run({ base, work }) {
    const tmpl = path.join(base, 'templates', 'project', 'memory');
    if (!fs.existsSync(path.join(tmpl, '.gitignore'))) return [{ id: 'gitignore-exists', source: SRC, pass: false, detail: 'нет templates/project/memory/.gitignore' }];
    const mem = path.join(work, 'memory');
    fs.cpSync(tmpl, mem, { recursive: true });
    for (const f of [...DERIVED, ...SOURCES]) {
      fs.mkdirSync(path.dirname(path.join(mem, f)), { recursive: true });
      fs.writeFileSync(path.join(mem, f), 'x\n');
    }
    // The hub's own pre-commit runs this: without GIT_DIR/GIT_INDEX_FILE git would answer for the hub repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const git = (...a) => spawnSync('git', a, { cwd: mem, env, encoding: 'utf8' });
    git('init', '-q');
    const r = git('status', '--porcelain', '--untracked-files=all');
    const seen = new Set(r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)));
    const leaked = DERIVED.filter((f) => seen.has(f));
    const hidden = SOURCES.filter((f) => !seen.has(f));
    return [
      { id: 'derived-ignored', source: SRC, pass: r.status === 0 && leaked.length === 0, detail: `git видит выводимые: ${leaked.join(', ')} ${r.stderr}` },
      { id: 'sources-tracked', kind: 'quiet', source: SRC, pass: r.status === 0 && hidden.length === 0, detail: `git не видит источники: ${hidden.join(', ')}` },
    ];
  },
};
