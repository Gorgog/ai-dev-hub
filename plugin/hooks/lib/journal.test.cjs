// node --test plugin/hooks/lib/journal.test.cjs
// The journal of the hook spine (hooks.jsonl): a line of a killed writer — a fragment without its newline — must not
// glue onto the next entry, the same race as the delivery's journal before slice 32 (decision B: every entry starts
// with a newline, no tail read; empty lines are normal and every reader skips them).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const { journal, file } = require('./journal.cjs');
// What the readers of hooks.jsonl do (tests, polygon H56, jq of docs/hooks.md): split by lines, skip empty ones.
const entries = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { torn: l }; } });

function withLogs(fn) {
  const before = process.env.HUB_LOG_DIR;
  process.env.HUB_LOG_DIR = mkdtemp('hub-journal-');
  try { return fn(process.env.HUB_LOG_DIR); } finally { if (before === undefined) delete process.env.HUB_LOG_DIR; else process.env.HUB_LOG_DIR = before; }
}

test('journal: a fragment of a killed writer stays a torn line of its own, the next entry is whole', () => withLogs(() => {
  journal({ type: 'health', problems: [] });
  fs.appendFileSync(file(), '{"at":"2026-11-06T10:00:00.000Z","type":"err'); // killed mid-line: no newline
  journal({ type: 'error', module: 'x.cjs', error: 'boom' });
  const got = entries(file());
  assert.deepStrictEqual(got.map((e) => e.type || 'torn'), ['health', 'torn', 'error'], fs.readFileSync(file(), 'utf8'));
  assert.strictEqual(got[2].error, 'boom');
}));

test('journal: every entry starts on its own line, readers that skip empty lines read them all', () => withLogs(() => {
  for (let i = 0; i < 3; i++) journal({ type: 'stdout', n: i });
  const text = fs.readFileSync(file(), 'utf8');
  assert.ok(text.startsWith('\n'), JSON.stringify(text.slice(0, 20)));
  assert.deepStrictEqual(entries(file()).map((e) => e.n), [0, 1, 2]);
}));

test('journal: a folder it cannot write never breaks the hook', () => {
  const before = process.env.HUB_LOG_DIR;
  const blocker = path.join(mkdtemp('hub-journal-'), 'file');
  fs.writeFileSync(blocker, '');
  process.env.HUB_LOG_DIR = path.join(blocker, 'sub'); // a file in the path: mkdir fails
  try { assert.doesNotThrow(() => journal({ type: 'health' })); } finally { if (before === undefined) delete process.env.HUB_LOG_DIR; else process.env.HUB_LOG_DIR = before; }
});
