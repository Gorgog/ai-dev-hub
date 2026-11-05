// node --test plugin/hooks/lib/events.test.cjs
// The event journal of the delivery: one line per event, appended O_APPEND in one write, a file per month; the
// reader skips a torn line; the «prevented» counter is derived from the events.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const events = require('./events.cjs');

const made = [];
const mkdtemp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-events-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const ADDR = { session_id: 's1', agent_id: 'main', tool_use_id: 't1', epoch: 1, model: 'm', mode: 'default' };

test('events: a line per event in the file of its month, long fields cut so a line stays small', () => {
  const dir = mkdtemp();
  events.append([{ at: '2026-11-05T10:00:00.000Z', kind: 'shown', lesson: 'L1', ...ADDR },
    { at: '2026-12-01T00:00:00.000Z', kind: 'shown', rule: 'x'.repeat(100000), ...ADDR }], dir);
  const nov = fs.readFileSync(path.join(dir, 'events', '2026-11.jsonl'), 'utf8').trim().split('\n');
  const dec = fs.readFileSync(path.join(dir, 'events', '2026-12.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(nov.length, 1);
  assert.strictEqual(JSON.parse(nov[0]).lesson, 'L1');
  assert.ok(dec[0].length < 4096, `line ${dec[0].length} bytes`);
  events.append([{ kind: 'shown', lesson: 'L2', ...ADDR }], dir);
  assert.ok(events.files(dir).length >= 2, 'at defaults to now');
});

test('events: 7 processes × 2000 events — no torn and no lost lines', async () => {
  const dir = mkdtemp();
  const writer = `const e = require(${JSON.stringify(require.resolve('./events.cjs'))});
    for (let i = 0; i < 2000; i++) e.append([{ at: '2026-11-05T10:00:00.000Z', kind: 'shown', lesson: 'L' + i, session_id: process.argv[1],
      agent_id: 'main', tool_use_id: 't' + i, epoch: 1, model: 'm', mode: 'default', pad: 'ё'.repeat(i % 300) }], process.argv[2]);`;
  await Promise.all(Array.from({ length: 7 }, (_, p) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', writer, `p${p}`, dir], { stdio: 'inherit' });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${p}: ${code}`))));
  })));
  const { events: all, torn } = events.read(path.join(dir, 'events', '2026-11.jsonl'));
  assert.strictEqual(torn, 0);
  assert.strictEqual(all.length, 14000);
  for (let p = 0; p < 7; p++) assert.strictEqual(all.filter((e) => e.session_id === `p${p}`).length, 2000);
});

test('events: the reader skips a torn line and counts it', () => {
  const dir = mkdtemp();
  const f = path.join(dir, 'x.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ kind: 'shown', lesson: 'L1' })}\n{"kind":"shown","les\n${JSON.stringify({ kind: 'shown', lesson: 'L2' })}\n{"kind":`);
  const r = events.read(f);
  assert.deepStrictEqual(r.events.map((e) => e.lesson), ['L1', 'L2']);
  assert.strictEqual(r.torn, 2);
  assert.deepStrictEqual(events.read(path.join(dir, 'none.jsonl')), { events: [], torn: 0 });
});

test('events: the «prevented» counter — per lesson and in total, without a detector «not measured»', () => {
  const ev = (kind, lesson, extra = {}) => ({ kind, lesson, ...ADDR, ...extra });
  const s = events.stats([
    ev('shown', 'L1', { detector: 'D1' }), ev('repeat', 'L1', { window: true, calls: 2 }),
    ev('shown', 'L2', { detector: 'D2' }), ev('prevented', 'L2', { calls: 3 }), ev('repeat', 'L2', { window: false, calls: 4 }),
    ev('shown', 'L3'),
    ev('shown', 'L4', { detector: 'D4' }), ev('expired', 'L4', { calls: 1 }),
    ev('shown', 'L2', { detector: 'D2', epoch: 2 }), ev('prevented', 'L2', { calls: 3, epoch: 2 }),
    { kind: 'shown', rule: 'rules-guard', ...ADDR },
  ]);
  assert.deepStrictEqual(s.lessons.L1, { shown: 1, prevented: 0, repeat: 1, late: 0, expired: 0, measured: true });
  assert.deepStrictEqual(s.lessons.L2, { shown: 2, prevented: 2, repeat: 0, late: 1, expired: 0, measured: true });
  assert.deepStrictEqual(s.lessons.L3, { shown: 1, prevented: 0, repeat: 0, late: 0, expired: 0, measured: false });
  assert.deepStrictEqual(s.lessons.L4, { shown: 1, prevented: 0, repeat: 0, late: 0, expired: 1, measured: true });
  assert.deepStrictEqual(s.total, { shown: 6, measured: 4, prevented: 2, repeat: 1, expired: 1, rate: 2 / 3 });
  assert.strictEqual(s.rules['rules-guard'].shown, 1);
});
