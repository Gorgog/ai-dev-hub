// node --test marks.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { found, fromRecords, tailRecords, record, readMarks, transcriptsFor, marksFileFor } = require('./marks.cjs');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

let n = 0;
const said = (text, extra = {}) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: '2026-10-01T10:00:00Z', message: { content: [{ type: 'text', text }] }, ...extra });
const sent = (message) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: '2026-10-01T10:00:00Z',
  message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'SendMessage', input: { to: 'x', message } }] } });
const human = (text) => ({ type: 'user', uuid: `u${++n}`, timestamp: '2026-10-01T10:00:00Z', message: { content: text } });

test('found: anywhere in Claude\'s text, only on a line of its own in a sent message; keys end on a letter or digit', () => {
  assert.deepStrictEqual(found('Беру.\n⏱ EST-START DEMO-5', ''), [{ kind: 'START', key: 'DEMO-5' }]);
  assert.deepStrictEqual(found('закрыл EST-END HUBV2-19.', ''), [{ kind: 'END', key: 'HUBV2-19' }]);
  assert.deepStrictEqual(found('', 'готово к мержу: X abc\n⏱ EST-END PROJ-1145-03'), [{ kind: 'END', key: 'PROJ-1145-03' }]);
  assert.deepStrictEqual(found('', 'В первом сообщении поставь ⏱ EST-START DEMO-9'), []);
  assert.deepStrictEqual(found('метка `EST-START <KEY>` — шаблон', ''), []);
});

test('fromRecords: Claude\'s text and sent messages, not the human, not tool input, not a subagent', () => {
  const recs = [
    human('поставь EST-START H-1'),
    said('⏱ EST-START A-1'),
    sent('принял бриф\n⏱ EST-START B-1'),
    { type: 'assistant', uuid: 'b1', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo EST-START C-1' } }] } },
    said('EST-END D-1', { isSidechain: true }),
  ];
  assert.deepStrictEqual(fromRecords(recs).map((m) => `${m.kind} ${m.key}`), ['START A-1', 'START B-1']);
});

test('tailRecords: only whole lines of the last bytes; no file — nothing', () => {
  const d = tmp();
  const f = path.join(d, 's.jsonl');
  const big = said('x'.repeat(5000));
  fs.writeFileSync(f, [big, said('⏱ EST-START T-1')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const recs = tailRecords(f, 2000);
  assert.strictEqual(recs.length, 1);
  assert.deepStrictEqual(fromRecords(recs).map((m) => m.key), ['T-1']);
  assert.deepStrictEqual(tailRecords(path.join(d, 'none.jsonl')), []);
});

test('record: one line per (session, kind, key); transcriptsFor lists the sessions of a key', () => {
  const d = tmp();
  const file = path.join(d, 'memory', 'est-marks.jsonl');
  const base = { session_id: 's1', transcript_path: '/t/s1.jsonl', cwd: '/w' };
  assert.strictEqual(record(file, [{ kind: 'START', key: 'K-1' }, { kind: 'START', key: 'K-1' }], base), 1);
  assert.strictEqual(record(file, [{ kind: 'START', key: 'K-1' }, { kind: 'END', key: 'K-1' }], base), 1);
  assert.strictEqual(record(file, [{ kind: 'START', key: 'K-1' }], { ...base, session_id: 's2', transcript_path: '/t/s2.jsonl' }), 1);
  assert.strictEqual(record(file, [], base), 0);
  const all = readMarks(file);
  assert.strictEqual(all.length, 3);
  assert.deepStrictEqual(Object.keys(all[0]).sort(), ['at', 'cwd', 'key', 'kind', 'session_id', 'transcript_path']);
  assert.deepStrictEqual(transcriptsFor(file, 'K-1'), ['/t/s1.jsonl', '/t/s2.jsonl']);
  assert.deepStrictEqual(transcriptsFor(file, 'K-12'), []);
  fs.appendFileSync(file, 'не json\n');
  assert.strictEqual(readMarks(file).length, 3);
  assert.deepStrictEqual(readMarks(path.join(d, 'none.jsonl')), []);
});

test('marksFileFor: the memory of the hub project above the working folder, null outside the hub projects', () => {
  assert.strictEqual(marksFileFor('/h/projects/demo/worktrees/K-1/src', '/h'), '/h/projects/demo/memory/est-marks.jsonl');
  assert.strictEqual(marksFileFor('/h/projects/demo', '/h'), '/h/projects/demo/memory/est-marks.jsonl');
  // A folder named projects inside a project's repo is not another project; another tree is not the hub.
  assert.strictEqual(marksFileFor('/h/projects/demo/repo/projects/x', '/h'), '/h/projects/demo/memory/est-marks.jsonl');
  assert.strictEqual(marksFileFor('/home/x/projects/demo', '/h'), null);
});
