// node --test plugin/lib/memory/events.test.cjs — memory events: one appendFileSync per line, monthly jsonl, fold.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { appendEvent, readEvents, foldEvents, MAX_LINE } = require('./events.cjs');

const mem = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ev-'));
  fs.mkdirSync(path.join(d, 'lessons'));
  return d;
};

test('append: a line in events/<YYYY-MM>.jsonl with the address fields in a fixed order', () => {
  const d = mem();
  appendEvent(d, { kind: 'shown', lesson: 'a-1', session_id: 's1', agent_id: null, tool_use_id: 't1', epoch: 2,
    model: 'm', mode: 'hook', at: '2026-11-05T10:00:00.000Z' });
  const text = fs.readFileSync(path.join(d, 'events', '2026-11.jsonl'), 'utf8');
  assert.strictEqual(text, '{"at":"2026-11-05T10:00:00.000Z","kind":"shown","lesson":"a-1","session_id":"s1","agent_id":null,'
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
  assert.match(r.problems[0], /2026-11\.jsonl:2/);
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
