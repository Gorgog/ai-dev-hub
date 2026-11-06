// Срез 32: хвосты записи jsonl, найденные ревью 26. Детерминированно, каждая гонка — в своём дочернем процессе:
// 1) журнал подачи (hooks/lib/events.cjs): обрывок «убитого» писателя ложится между проверкой хвоста и write — целое
//    событие следующего вызова не должно приклеиться к обрывку и пропасть; контроль — старый способ «прочитать последний
//    байт → write» на той же постановке склеивает (иначе проверка не может провалиться);
// 2) memory-gc fold --apply: событие, дописанное в старый inode месяца во время свёртки, не теряется; месяц
//    переименовывается под замком событий;
// 3) файл замка событий только для чтения: событие записано, в журнале хуков — строка type=error (не молча).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = 'срез 32 / ревью 26: склейка в журнале подачи, потеря события при свёртке, замок только для чтения';

// The delivery log race: `mode` new — the plugin's append; old — the tail check of v1 (read the last byte → write).
const DELIVERY = `'use strict';
const fs = require('fs'), path = require('path');
const [lib, dir, mode] = process.argv.slice(2);
const ev = require(lib);
const f = path.join(dir, 'events', '2026-11.jsonl');
const A = { session_id: 's', agent_id: 'main', tool_use_id: 't', epoch: 1, model: 'm', mode: 'polygon' };
const old = (list) => {
  const text = list.map((e) => JSON.stringify(e) + '\\n').join('');
  const fd = fs.openSync(f, 'a+');
  try {
    const size = fs.fstatSync(fd).size, last = Buffer.alloc(1);
    const open = size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    fs.writeSync(fd, open ? '\\n' + text : text);
  } finally { fs.closeSync(fd); }
};
const put = mode === 'old' ? old : (list) => ev.append(list, dir);
put([{ at: '2026-11-05T10:00:00.000Z', kind: 'shown', lesson: 'L0', ...A }]);
const real = fs.writeSync;
let staged = false;
fs.writeSync = function (fd, ...rest) {
  if (!staged) { staged = true; fs.appendFileSync(f, '{"at":"2026-11-05T10:00:00.500Z","kind":"sho'); }
  return real.call(this, fd, ...rest);
};
try { put([{ at: '2026-11-05T10:00:01.000Z', kind: 'shown', lesson: 'L1', ...A }, { at: '2026-11-05T10:00:01.000Z', kind: 'shown', lesson: 'L2', ...A }]); }
finally { fs.writeSync = real; }
const r = ev.read(f);
process.stdout.write(JSON.stringify({ staged, lessons: r.events.map((e) => e.lesson), torn: r.torn }));
`;

// fold while a writer without the lock appends into the month; the lock is probed from a second connection.
const FOLD = `'use strict';
const fs = require('fs'), path = require('path');
const [plugin, mem] = process.argv.slice(2);
const E = require(path.join(plugin, 'lib', 'memory', 'events.cjs'));
const D = require(path.join(plugin, 'lib', 'memory', 'sqlite.cjs'))();
for (let d = 1; d <= 3; d++) E.appendEvent(mem, { at: '2026-05-0' + d + 'T10:00:00.000Z', kind: 'shown', lesson: 'dev-port' });
const month = path.join(mem, 'events', '2026-05.jsonl');
const real = fs.renameSync;
let lock = null;
fs.renameSync = function (from, to) {
  if (to === month && lock === null) {
    fs.appendFileSync(month, '\\n' + JSON.stringify({ at: '2026-05-04T10:00:00.000Z', kind: 'repeat', lesson: 'dev-port' }) + '\\n');
    if (!D) lock = 'no-sqlite';
    else {
      const db = new D(path.join(mem, '.events.lock.db'), { timeout: 0 });
      try { db.exec('BEGIN EXCLUSIVE'); db.exec('COMMIT'); lock = 'free'; } catch { lock = 'held'; } finally { db.close(); }
    }
  }
  return real.call(this, from, to);
};
const { main } = require(path.join(plugin, 'skills', 'memory-gc', 'scripts', 'gc.cjs'));
let out = '';
try { out = main(['--memory', mem, 'fold', '--now', '2026-11-05', '--apply']); } finally { fs.renameSync = real; }
const r = E.readEvents(mem);
process.stdout.write(JSON.stringify({ lock, out, may: r.events.filter((e) => String(e.at).startsWith('2026-05')).map((e) => e.kind + ':' + e.at.slice(8, 10)), problems: r.problems }));
`;

const RO = `'use strict';
const [lib, mem] = process.argv.slice(2);
const E = require(lib);
for (let i = 1; i <= 3; i++) E.appendEvent(mem, { kind: 'shown', lesson: 'a-' + i, at: '2026-11-05T10:00:0' + i + '.000Z' });
process.stdout.write(JSON.stringify(E.readEvents(mem).events.map((e) => e.lesson)));
`;

const node = (file, args, env = {}) => {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env } });
  try { return { ok: r.status === 0, out: JSON.parse(r.stdout), err: r.stderr }; } catch { return { ok: false, out: null, err: `${r.stdout}\n${r.stderr}`.slice(-300) }; }
};

module.exports = {
  id: 'H56', level: 'hook', mech: 'memory-store', title: 'jsonl: склейка журнала подачи, событие при свёртке, замок только для чтения',
  async run({ pluginDir, work }) {
    const lib = path.join(pluginDir, 'hooks', 'lib', 'events.cjs');
    const mlib = path.join(pluginDir, 'lib', 'memory', 'events.cjs');
    const scripts = { delivery: path.join(work, 'delivery.cjs'), fold: path.join(work, 'fold.cjs'), ro: path.join(work, 'ro.cjs') };
    fs.writeFileSync(scripts.delivery, DELIVERY);
    fs.writeFileSync(scripts.fold, FOLD);
    fs.writeFileSync(scripts.ro, RO);
    const dir = (name) => { const d = path.join(work, name); fs.mkdirSync(path.join(d, 'events'), { recursive: true }); return d; };
    const mem = (name) => { const d = dir(name); fs.mkdirSync(path.join(d, 'lessons'), { recursive: true }); return d; };

    const now = node(scripts.delivery, [lib, dir('delivery-new'), 'new']);
    const ctl = node(scripts.delivery, [lib, dir('delivery-old'), 'old']);
    const whole = (r) => r.ok && r.out.staged && ['L0', 'L1', 'L2'].every((l) => r.out.lessons.includes(l));

    const fm = mem('fold');
    const fold = node(scripts.fold, [pluginDir, fm]);
    const foldOk = fold.ok && JSON.stringify(fold.out.may) === JSON.stringify(['shown:03', 'repeat:04']) && !fold.out.problems.length;

    const rm = mem('ro');
    const logs = path.join(work, 'ro-logs');
    const first = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mlib)}).appendEvent(${JSON.stringify(rm)},{kind:'shown',lesson:'a-0',at:'2026-11-05T10:00:00.000Z'})`]);
    const lockFile = path.join(rm, '.events.lock.db');
    const hasLock = first.status === 0 && fs.existsSync(lockFile);
    if (hasLock) fs.chmodSync(lockFile, 0o444);
    const ro = node(scripts.ro, [mlib, rm], { HUB_LOG_DIR: logs });
    let errs = [];
    try { errs = fs.readFileSync(path.join(logs, 'hooks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'error' && e.module === 'lib/memory/events.cjs'); } catch { /* none */ }
    const root = process.getuid && process.getuid() === 0;

    return [
      { id: 'delivery-no-glue', mech: 'delivery', source: SRC, pass: whole(now),
        detail: `журнал подачи: ${JSON.stringify(now.out || now.err)}` },
      { id: 'delivery-control-glues', mech: 'delivery', observe: true, source: 'контроль: «прочитать последний байт → write» на той же постановке',
        pass: ctl.ok && ctl.out.staged && !whole(ctl), detail: `старый способ: ${JSON.stringify(ctl.out || ctl.err)}` },
      { id: 'fold-keeps-late-event', source: SRC, pass: foldOk, detail: JSON.stringify(fold.out || fold.err) },
      { id: 'fold-under-lock', source: SRC, pass: fold.ok && (fold.out.lock === 'held' || fold.out.lock === 'no-sqlite'),
        detail: `замок событий во время rename: ${fold.ok ? fold.out.lock : fold.err}` },
      { id: 'ro-lock-visible', source: SRC, pass: root || (hasLock && ro.ok && ro.out.length === 4 && errs.length === 1),
        detail: root ? 'root пишет и в файл 444 — проверка не о чём' : `события ${JSON.stringify(ro.out || ro.err)}, строк type=error ${errs.length}${errs[0] ? `: ${errs[0].error}` : ''}` },
    ];
  },
};
