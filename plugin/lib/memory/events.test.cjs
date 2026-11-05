// node --test plugin/lib/memory/events.test.cjs — memory events: one appendFileSync per line, monthly jsonl, fold.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { appendEvent, readEvents, foldEvents, MAX_LINE } = require('./events.cjs');

const mem = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ev-'));
  fs.mkdirSync(path.join(d, 'lessons'));
  return d;
};

test('append: a line in events/<YYYY-MM>.jsonl with the address fields in a fixed order; a leading \\n (review 1)', () => {
  const d = mem();
  appendEvent(d, { kind: 'shown', lesson: 'a-1', session_id: 's1', agent_id: null, tool_use_id: 't1', epoch: 2,
    model: 'm', mode: 'hook', at: '2026-11-05T10:00:00.000Z' });
  const text = fs.readFileSync(path.join(d, 'events', '2026-11.jsonl'), 'utf8');
  assert.strictEqual(text, '\n{"at":"2026-11-05T10:00:00.000Z","kind":"shown","lesson":"a-1","session_id":"s1","agent_id":null,'
    + '"tool_use_id":"t1","epoch":2,"model":"m","mode":"hook"}\n');
});

test('append: `at` is filled, a long note is cut so the line stays ≤ MAX_LINE bytes; no lesson — refused', () => {
  const d = mem();
  const line = appendEvent(d, { kind: 'repeat', lesson: 'a-1', note: 'ж'.repeat(10000) });
  assert.ok(Buffer.byteLength(line) <= MAX_LINE, String(Buffer.byteLength(line)));
  const { events } = readEvents(d);
  assert.strictEqual(events.length, 1);
  assert.match(events[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.throws(() => appendEvent(d, { kind: 'shown' }), /lesson/);
});

test('read: a torn last line is skipped and named; the next append closes it with a newline first', () => {
  const d = mem();
  appendEvent(d, { kind: 'shown', lesson: 'a-1', at: '2026-11-05T10:00:00.000Z' });
  const f = path.join(d, 'events', '2026-11.jsonl');
  fs.appendFileSync(f, '{"at":"2026-11-05T10:00:01.000Z","kind":"sho');
  let r = readEvents(d);
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.problems.length, 1);
  assert.match(r.problems[0], new RegExp(`2026-11\\.jsonl:${fs.readFileSync(f, 'utf8').split('\n').length}`), 'the physical line of the fragment');
  appendEvent(d, { kind: 'repeat', lesson: 'a-1', at: '2026-11-05T10:00:02.000Z' });
  r = readEvents(d);
  assert.deepStrictEqual(r.events.map((e) => e.kind), ['shown', 'repeat']);
  assert.strictEqual(r.problems.length, 1);
});

test('fold: per-lesson counters and the last time, merged/superseded/retired counted for the lesson that left', () => {
  const ev = [
    { at: '2026-11-01T00:00:00Z', kind: 'shown', lesson: 'a' },
    { at: '2026-11-02T00:00:00Z', kind: 'shown', lesson: 'a' },
    { at: '2026-11-03T00:00:00Z', kind: 'repeat', lesson: 'a' },
    { at: '2026-11-04T00:00:00Z', kind: 'merged', lesson: 'b', into: 'a' },
    { at: '2026-11-05T00:00:00Z', kind: 'retired', lesson: 'c' },
  ];
  assert.deepStrictEqual(foldEvents(ev), {
    a: { shown: 2, repeat: 1, merged: 0, superseded: 0, retired: 0, last: '2026-11-03T00:00:00Z' },
    b: { shown: 0, repeat: 0, merged: 1, superseded: 0, retired: 0, last: '2026-11-04T00:00:00Z' },
    c: { shown: 0, repeat: 0, merged: 0, superseded: 0, retired: 1, last: '2026-11-05T00:00:00Z' },
  });
});

test('7 processes × 300 events in parallel: every line whole, none lost', async () => {
  const d = mem();
  const lib = path.join(__dirname, 'events.cjs');
  const code = `const {appendEvent}=require(${JSON.stringify(lib)});const w=process.argv[1];`
    + `for(let i=0;i<300;i++)appendEvent(${JSON.stringify(d)},{kind:'shown',lesson:'l'+(i%7),session_id:'s'+w,epoch:i,note:'ж'.repeat(i%50*20)});`;
  await Promise.all(Array.from({ length: 7 }, (_, w) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', code, String(w)], { stdio: 'inherit' });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`writer ${w}: ${c}`))));
  })));
  const { events, problems } = readEvents(d);
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(events.length, 2100);
  for (let w = 0; w < 7; w++) assert.strictEqual(events.filter((e) => e.session_id === `s${w}`).length, 300);
});

// H22 (slice 26): a SIGKILL tears a write only between 4 KB pages, and healing a torn tail by «read the last byte, then
// write» glued a neighbour's whole event onto a fragment. Now: under a kernel lock (node:sqlite BEGIN EXCLUSIVE) — heal,
// pad with \n to the page boundary when the line would cross it, one write. Without node:sqlite — a \n frame.
const PAGE = 4096;
function pages(file) {
  const buf = fs.readFileSync(file);
  const bad = [];
  let off = 0, n = 0;
  while (off < buf.length) {
    let nl = buf.indexOf(0x0a, off);
    if (nl < 0) nl = buf.length - 1;
    if (nl > off) {
      n++;
      if (Math.floor(off / PAGE) !== Math.floor(nl / PAGE)) bad.push(`строка с ${off} до ${nl} через границу страницы`);
      if (/^\s+$/.test(buf.subarray(off, nl).toString('latin1'))) bad.push(`строка из пробелов с ${off}`);
    }
    off = nl + 1;
  }
  return { n, bad };
}

test('append: no line crosses a 4 KB page; the padding is bare \\n; every event reads back', () => {
  const d = mem();
  for (let i = 0; i < 200; i++) appendEvent(d, { kind: 'shown', lesson: 'l', epoch: i, note: 'ж'.repeat((i * 37) % 900), at: '2026-11-05T00:00:00.000Z' });
  const p = pages(path.join(d, 'events', '2026-11.jsonl'));
  assert.deepStrictEqual(p.bad, []);
  assert.strictEqual(p.n, 200);
  const { events, problems } = readEvents(d);
  assert.strictEqual(events.length, 200);
  assert.deepStrictEqual(problems, []);
  assert.ok(MAX_LINE <= PAGE, 'a line must fit one page');
});

test('append: 4 processes at once — no line crosses a page, none lost, the lock file is neither read nor exported', async () => {
  const d = mem();
  const lib = path.join(__dirname, 'events.cjs');
  const code = (w) => `const {appendEvent}=require(${JSON.stringify(lib)});for(let i=0;i<150;i++)appendEvent(${JSON.stringify(d)},{kind:'shown',lesson:'l',session_id:'w${w}',epoch:i,note:'ж'.repeat((i*53+${w}*7)%1200),at:'2026-11-05T00:00:00.000Z'})`;
  await Promise.all([0, 1, 2, 3].map((w) => new Promise((ok, no) => spawn(process.execPath, ['-e', code(w)], { stdio: 'inherit' })
    .on('exit', (c) => (c === 0 ? ok() : no(new Error(`писатель ${w}: код ${c}`)))))));
  const p = pages(path.join(d, 'events', '2026-11.jsonl'));
  assert.deepStrictEqual(p.bad, []);
  const { events, problems } = readEvents(d);
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(events.length, 600);
  const S = require('./store.cjs');
  assert.ok(!S.exportAll(d).files.some((f) => /lock/.test(f.path)), 'lock file not exported');
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'events')), ['2026-11.jsonl'], 'events/ holds only the month');
});

test('append: a torn tail left by a killed writer stays its own line — the next event is whole', () => {
  const d = mem();
  appendEvent(d, { kind: 'shown', lesson: 'a', at: '2026-11-05T00:00:00.000Z' });
  fs.appendFileSync(path.join(d, 'events', '2026-11.jsonl'), '{"kind":"sho');
  appendEvent(d, { kind: 'shown', lesson: 'b', at: '2026-11-05T00:00:01.000Z' });
  const { events, problems } = readEvents(d);
  assert.deepStrictEqual(events.map((e) => e.lesson), ['a', 'b']);
  assert.strictEqual(problems.length, 1);
});

test('append without node:sqlite: a \\n frame — a torn fragment never glues onto the next event', () => {
  const d = mem();
  const f = path.join(d, 'events', '2026-11.jsonl');
  const lib = path.join(__dirname, 'events.cjs');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"kind":"sho');
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(lib)}).appendEvent(${JSON.stringify(d)},{kind:'shown',lesson:'b',at:'2026-11-05T00:00:01.000Z'})`],
    { env: { ...process.env, HUB_MEMORY_ENGINE: 'js' } });
  assert.match(fs.readFileSync(f, 'utf8'), /^\{"kind":"sho\n\{"at"[^\n]*"lesson":"b"[^\n]*\}\n$/);
  assert.ok(!fs.readdirSync(d).some((x) => /lock/.test(x)), 'no lock file without node:sqlite');
});

test('append: a lock held by a stuck process (stopped, hung) — no long wait: the \\n frame within a second, the event whole', async () => {
  const d = mem();
  appendEvent(d, { kind: 'shown', lesson: 'a', at: '2026-11-05T00:00:00.000Z' });
  const { LOCK } = require('./events.cjs');
  const holder = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path.join(d, LOCK))});db.exec('BEGIN EXCLUSIVE');process.stdout.write('held');setTimeout(()=>{},5000)`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((ok) => holder.stdout.once('data', ok));
  try {
    const t0 = Date.now();
    appendEvent(d, { kind: 'shown', lesson: 'b', at: '2026-11-05T00:00:01.000Z' });
    assert.ok(Date.now() - t0 < 600, `ждал ${Date.now() - t0} мс`);
  } finally { holder.kill('SIGKILL'); }
  const { events, problems } = readEvents(d);
  assert.deepStrictEqual(events.map((e) => e.lesson), ['a', 'b']);
  assert.deepStrictEqual(problems, []);
});

test('append: a stuck lock costs one wait per process — 20 events of one hook process within a second', async () => {
  const d = mem();
  const { LOCK } = require('./events.cjs');
  appendEvent(d, { kind: 'shown', lesson: 'a', at: '2026-11-05T00:00:00.000Z' });
  const holder = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path.join(d, LOCK))});db.exec('BEGIN EXCLUSIVE');process.stdout.write('held');setTimeout(()=>{},8000)`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((ok) => holder.stdout.once('data', ok));
  const lib = path.join(__dirname, 'events.cjs');
  try {
    const t0 = Date.now();
    execFileSync(process.execPath, ['-e', `const {appendEvent}=require(${JSON.stringify(lib)});for(let i=0;i<20;i++)appendEvent(${JSON.stringify(d)},{kind:'shown',lesson:'b',epoch:i,at:'2026-11-05T00:00:01.000Z'})`]);
    assert.ok(Date.now() - t0 < 1000, `20 событий за ${Date.now() - t0} мс`);
  } finally { holder.kill('SIGKILL'); }
  assert.strictEqual(readEvents(d).events.length, 21);
});

test('append under the lock: a fragment of an unlocked writer that lands between the size check and the write never glues', () => {
  // In a fresh process: a lock found stuck earlier in this one would frame the write and skip the locked path.
  const d = mem();
  const f = path.join(d, 'events', '2026-11.jsonl');
  const fragment = '\n{"at":"2026-11-05T00:00:00.500Z","kind":"sho'; // a frame writer killed mid-write
  const code = [
    "const fs = require('fs');",
    `const { appendEvent } = require(${JSON.stringify(path.join(__dirname, 'events.cjs'))});`,
    `const d = ${JSON.stringify(d)}, f = ${JSON.stringify(f)}, fragment = ${JSON.stringify(fragment)};`,
    "appendEvent(d, { kind: 'shown', lesson: 'a', at: '2026-11-05T00:00:00.000Z' });",
    'const orig = fs.writeSync; let once = true;',
    'fs.writeSync = function (fd, ...rest) { if (once) { once = false; fs.appendFileSync(f, fragment); } return orig.call(fs, fd, ...rest); };',
    "appendEvent(d, { kind: 'repeat', lesson: 'b', at: '2026-11-05T00:00:01.000Z' });",
    "fs.writeSync = orig; process.stdout.write(once ? 'no-fragment' : 'ok');",
  ].join('\n');
  assert.strictEqual(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }), 'ok', 'the fragment was put in on the locked path');
  assert.deepStrictEqual(readEvents(d).events.map((e) => e.lesson), ['a', 'b']);
});
