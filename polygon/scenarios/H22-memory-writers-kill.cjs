// Приёмочный тест памяти 1 (acceptance §2): 7 процессов × 2000 событий через интерфейс хранения (подача), kill -9
// случайного каждые 50 мс с перезапуском с последнего целого события, плюс 2 писателя уроков (Write-подобная запись
// файла целиком, без атомарности). Пороги: рваных и потерянных строк jsonl 0; индекс = свёртка (файлы + события) в
// 100 % проверок — проверка замораживает всех писателей (SIGSTOP), отдельный процесс-«сессия» пересобирает индекс по
// подписи и сверяет его со свёрткой, затем SIGCONT. Контроль: те же события двумя write с паузой — kill их рвёт.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SRC = 'acceptance §2 тест 1 [Г]: 7 процессов × 2000 событий, kill -9 каждые 50 мс, 2 писателя уроков';
const WRITERS = 7, EVENTS = 2000, LESSONS = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The writer: events seq <from>..EVENTS-1 of worker <w> through the store's «shown»; split — the control arm.
const WRITER = `'use strict';
const fs = require('fs');
const [lib, mem, w, from, mode] = process.argv.slice(2);
const S = require(lib);
const pause = new Int32Array(new SharedArrayBuffer(4));
for (let seq = Number(from); seq < ${EVENTS}; seq++) {
  const ev = { lesson: 'l' + (seq % ${LESSONS}), session_id: 'w' + w, epoch: seq, mode: 'polygon', note: 'ж'.repeat((seq * 37 + Number(w) * 11) % 300) };
  if (mode === 'split') {
    const line = Buffer.from(JSON.stringify({ at: new Date().toISOString(), kind: 'shown', ...ev }) + '\\n');
    const f = mem + '/events/' + new Date().toISOString().slice(0, 7) + '.jsonl';
    fs.appendFileSync(f, line.subarray(0, line.length >> 1)); Atomics.wait(pause, 0, 0, 1); fs.appendFileSync(f, line.subarray(line.length >> 1));
  } else S.shown(mem, ev.lesson, ev);
  Atomics.wait(pause, 0, 0, 0.3);
}
`;
// A lesson writer: rewrites one of the lessons whole every few ms, as the Write tool does (truncate + write).
const LESSON_WRITER = `'use strict';
const fs = require('fs');
const [lib, mem, w] = process.argv.slice(2);
const { formatLesson } = require(lib.replace(/store\\.cjs$/, 'format.cjs'));
const pause = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; ; i++) {
  const id = 'l' + ((i * 5 + Number(w)) % ${LESSONS});
  fs.writeFileSync(mem + '/lessons/' + id + '.md', formatLesson({ id, kind: 'rule', when: [], keys: ['k' + i], status: 'active',
    supersedes: [], source: 'модель', created: '2026-11-05' }, ['Урок ' + id + ', версия ' + i + ' писателя ' + w + '.', 'Вторая строка.']));
  Atomics.wait(pause, 0, 0, 7);
}
`;
// A «session» that asks the memory: rebuild by signature, then index fold vs. the fold of the files and events. Then,
// with everything still frozen, the two paths the writers never leave to chance: no change — the index stays as it is;
// one event alone — the index is rebuilt and equals the fold again (a signature blind to events fails here).
const CHECKER = `'use strict';
const [lib, mem] = process.argv.slice(2);
const S = require(lib);
const same = () => JSON.stringify(S.indexFold(mem)) === JSON.stringify(S.fold(mem));
const ix = S.ensureIndex(mem);
const first = same();
const fresh = S.ensureIndex(mem).rebuilt === false;
S.shown(mem, 'l0', { session_id: 'checker', mode: 'polygon' });
const afterEvent = S.ensureIndex(mem).rebuilt === true && same();
process.stdout.write(JSON.stringify({ equal: first && fresh && afterEvent, first, fresh, afterEvent, engine: ix.engine, rebuilt: ix.rebuilt, ms: ix.ms }));
`;

function lastSeq(mem, w) {
  let max = -1;
  for (const f of fs.existsSync(path.join(mem, 'events')) ? fs.readdirSync(path.join(mem, 'events')) : []) {
    for (const l of fs.readFileSync(path.join(mem, 'events', f), 'utf8').split('\n')) {
      if (!l.includes(`"w${w}"`)) continue;
      try { const e = JSON.parse(l); if (e.session_id === `w${w}` && e.epoch > max) max = e.epoch; } catch { /* torn */ }
    }
  }
  return max;
}

function audit(mem) {
  let lines = 0, torn = 0;
  const seen = Array.from({ length: WRITERS }, () => new Map());
  for (const f of fs.readdirSync(path.join(mem, 'events'))) {
    for (const l of fs.readFileSync(path.join(mem, 'events', f), 'utf8').split('\n')) {
      if (!l) continue;
      lines++;
      let e;
      try { e = JSON.parse(l); } catch { torn++; continue; }
      if (e && e.session_id === 'checker') continue; // the checker's own probe events
      const w = e && typeof e.session_id === 'string' ? Number(e.session_id.slice(1)) : -1;
      if (!seen[w]) { torn++; continue; }
      seen[w].set(e.epoch, (seen[w].get(e.epoch) || 0) + 1);
    }
  }
  let missing = 0, dups = 0;
  for (const m of seen) for (let s = 0; s < EVENTS; s++) { const n = m.get(s) || 0; if (!n) missing++; if (n > 1) dups += n - 1; }
  return { lines, torn, missing, dups };
}

// One arm: writers under kill -9 until each wrote all its events; checks every 3rd kill (mechanism arm only).
async function arm(lib, mem, scripts, mode, { checks, maxMs }) {
  const kids = new Map();
  const done = new Set();
  let kills = 0, stopped = false;
  const results = [];
  const start = (w) => {
    if (stopped) return;
    const from = lastSeq(mem, w) + 1;
    if (from >= EVENTS) { done.add(w); return; }
    const p = spawn(process.execPath, [scripts.writer, lib, mem, String(w), String(from), mode], { stdio: 'ignore' });
    kids.set(w, p);
    p.on('exit', (code) => { kids.delete(w); if (code === 0) done.add(w); else setImmediate(() => start(w)); });
  };
  const lessonKids = checks ? [0, 1].map((w) => spawn(process.execPath, [scripts.lesson, lib, mem, String(w)], { stdio: 'ignore' })) : [];
  const t0 = Date.now();
  try {
    for (let w = 0; w < WRITERS; w++) start(w);
    for (let tick = 1; done.size < WRITERS && Date.now() - t0 < maxMs; tick++) {
      await sleep(50);
      const live = [...kids.values()];
      if (live.length) { live[Math.floor(Math.random() * live.length)].kill('SIGKILL'); kills++; }
      if (checks && tick % 3 === 0) {
        const all = [...kids.values(), ...lessonKids];
        for (const p of all) p.kill('SIGSTOP');
        try {
          const r = spawnSync(process.execPath, [scripts.checker, lib, mem], { encoding: 'utf8', timeout: 20000 });
          results.push(r.status === 0 ? JSON.parse(r.stdout) : { equal: false, error: (r.stderr || '').slice(-300) });
        } finally { for (const p of all) p.kill('SIGCONT'); }
      }
    }
  } finally {
    stopped = true;
    for (const p of [...kids.values(), ...lessonKids]) { p.kill('SIGCONT'); p.kill('SIGKILL'); }
  }
  await sleep(100);
  return { kills, wallMs: Date.now() - t0, finished: done.size, results };
}

module.exports = {
  id: 'H22', level: 'hook', mech: 'memory-store', title: 'Память: 7 писателей событий под kill -9 + 2 писателя уроков (тест 1)',
  async run({ pluginDir, work }) {
    const lib = path.join(pluginDir, 'lib', 'memory', 'store.cjs');
    if (!fs.existsSync(lib)) {
      return [{ id: 'store-exists', source: SRC, pass: false, detail: 'нет интерфейса хранения plugin/lib/memory/store.cjs' }];
    }
    const scripts = { writer: path.join(work, 'writer.cjs'), lesson: path.join(work, 'lesson-writer.cjs'), checker: path.join(work, 'checker.cjs') };
    fs.writeFileSync(scripts.writer, WRITER);
    fs.writeFileSync(scripts.lesson, LESSON_WRITER);
    fs.writeFileSync(scripts.checker, CHECKER);
    const mkMem = (name) => {
      const mem = path.join(work, name, 'memory');
      fs.mkdirSync(path.join(mem, 'lessons'), { recursive: true });
      fs.mkdirSync(path.join(mem, 'events'), { recursive: true });
      return mem;
    };
    const mem = mkMem('one');
    const one = await arm(lib, mem, scripts, 'one', { checks: true, maxMs: 60000 });
    const a = audit(mem);
    // Control: the same kills on events written in two halves — must tear, or the test could not fail.
    const ctlMem = mkMem('split');
    const ctl = await arm(lib, ctlMem, scripts, 'split', { checks: false, maxMs: 4000 });
    const c = audit(ctlMem);
    const eq = one.results.filter((r) => r.equal).length;
    const ms = one.results.map((r) => r.ms || 0).sort((x, y) => x - y);
    return [
      { id: 'all-written', kind: 'never', source: SRC, pass: one.finished === WRITERS,
        detail: `дописали ${one.finished}/${WRITERS} за ${one.wallMs} мс, kill -9: ${one.kills}` },
      { id: 'jsonl-torn-0', kind: 'never', source: SRC, pass: a.torn === 0, detail: `рваных строк ${a.torn} из ${a.lines}` },
      { id: 'jsonl-lost-0', kind: 'never', source: SRC, pass: a.missing === 0 && a.dups === 0,
        detail: `потеряно ${a.missing}, дублей ${a.dups} из ${WRITERS * EVENTS}` },
      { id: 'index-equals-fold', source: SRC, pass: one.results.length >= 5 && eq === one.results.length,
        detail: `индекс = свёртка в ${eq}/${one.results.length} проверок; пересборка p50 ${Math.round(ms[ms.length >> 1] || 0)} мс, `
          + `макс ${Math.round(ms[ms.length - 1] || 0)} мс; ${(one.results.find((r) => !r.equal) || {}).error || ''}` },
      { id: 'control-tears', observe: true, source: 'P15: контроль — событие двумя write рвётся под kill -9', pass: c.torn > 0,
        detail: `контроль: рваных ${c.torn} из ${c.lines} при ${ctl.kills} kill -9` },
    ];
  },
};
