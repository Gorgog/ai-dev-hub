// Срез 36: журнал хребта hooks.jsonl — обрывок «убитого» писателя (строка без перевода строки) не склеивает следующую
// запись: каждая запись с ведущего \n (решение B журнала подачи, срез 32), пустые строки — норма, читатели их
// пропускают. Детерминированно, в дочернем процессе; контроль — старая запись «строка + \n» на той же постановке
// склеивает (иначе проверка не может провалиться).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = 'срез 36: склейка в журнале хуков hooks.jsonl — тот же класс, что журнал подачи до среза 32';

// `mode` new — journal() of the plugin; old — the write before slice 36: JSON + '\n', no leading newline.
const WRITER = `'use strict';
const fs = require('fs'), path = require('path');
const [lib, mode] = process.argv.slice(2);
const J = require(lib);
const put = mode === 'old'
  ? (e) => { fs.mkdirSync(J.dir(), { recursive: true }); fs.appendFileSync(J.file(), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\\n'); }
  : J.journal;
put({ type: 'health', problems: [] });
fs.appendFileSync(J.file(), '{"at":"2026-11-06T10:00:00.000Z","type":"err');
put({ type: 'error', module: 'x.cjs', error: 'boom' });
const lines = fs.readFileSync(J.file(), 'utf8').split('\\n').filter(Boolean);
const parsed = lines.map((l) => { try { return JSON.parse(l).type; } catch { return 'torn'; } });
process.stdout.write(JSON.stringify(parsed));
`;

const node = (file, args, env) => {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env } });
  try { return { ok: r.status === 0, out: JSON.parse(r.stdout) }; } catch { return { ok: false, out: `${r.stdout}\n${r.stderr}`.slice(-300) }; }
};

module.exports = {
  id: 'H61', level: 'hook', mech: 'spine', title: 'Журнал хуков: обрывок убитого писателя не склеивает следующую запись (36)',
  async run({ pluginDir, work }) {
    const lib = path.join(pluginDir, 'hooks', 'lib', 'journal.cjs');
    const script = path.join(work, 'writer.cjs');
    fs.writeFileSync(script, WRITER);
    const now = node(script, [lib, 'new'], { HUB_LOG_DIR: path.join(work, 'logs-new') });
    const ctl = node(script, [lib, 'old'], { HUB_LOG_DIR: path.join(work, 'logs-old') });
    const whole = (r) => r.ok && JSON.stringify(r.out) === JSON.stringify(['health', 'torn', 'error']);
    return [
      { id: 'journal-no-glue', source: SRC, pass: whole(now), detail: `строки журнала: ${JSON.stringify(now.out)}` },
      { id: 'journal-control-glues', observe: true, source: 'контроль: запись без ведущего \\n на той же постановке',
        pass: ctl.ok && !whole(ctl), detail: `старая запись: ${JSON.stringify(ctl.out)}` },
    ];
  },
};
