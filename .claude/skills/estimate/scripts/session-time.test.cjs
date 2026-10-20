// node --test session-time.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFile, measure, slugFor, findByKey } = require('./session-time.cjs');

const T0 = Date.parse('2026-10-20T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const human = (min, text) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: text } });
const said = (min, text) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'text', text }] } });
const toolUse = (min) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo EST-START TASK-1' } }] } });
const toolResult = (min) => ({ type: 'user', timestamp: at(min), message: { content: [{ type: 'tool_result', content: 'ok' }] } });

function transcript(dir, name, lines) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

const LINES = [
  human(0, 'возьми TASK-1'),
  said(1, 'Оценка …\n⏱ EST-START TASK-1'),
  toolUse(10),
  toolResult(11),
  said(20, 'Пушить?'),
  human(50, 'да'),
  said(55, '⏱ EST-END TASK-1'),
  human(60, 'другое'),
  { type: 'user', timestamp: at(65), message: { role: 'user', content: '<task-notification>agent done</task-notification>' } },
  said(70, 'готово'),
];

test('whole transcript: active and waiting split at human messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const r = measure(parseFile(transcript(dir, 'a.jsonl', LINES)));
  assert.strictEqual(r.activeMin, 1 + 9 + 1 + 9 + 5 + 5 + 5);
  assert.strictEqual(r.waitMin, 30 + 5);
  assert.strictEqual(r.humanMessages, 2);
});

test('key window: from EST-START to EST-END in assistant text only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const r = measure(parseFile(transcript(dir, 'a.jsonl', LINES)), { key: 'TASK-1' });
  assert.strictEqual(r.activeMin, 9 + 1 + 9 + 5);
  assert.strictEqual(r.waitMin, 30);
  assert.strictEqual(r.humanMessages, 1);
  assert.strictEqual(r.ended, true);
});

test('key without EST-END runs to the end of the transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const lines = LINES.filter((l) => !JSON.stringify(l).includes('EST-END'));
  const r = measure(parseFile(transcript(dir, 'a.jsonl', lines)), { key: 'TASK-1' });
  assert.strictEqual(r.ended, false);
  assert.strictEqual(r.activeMin, 9 + 1 + 9 + 5 + 5);
  assert.strictEqual(r.waitMin, 30 + 10);
});

test('TASK-1 does not match TASK-12', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const lines = [human(0, 'x'), said(1, '⏱ EST-START TASK-12'), said(5, 'y')];
  assert.strictEqual(measure(parseFile(transcript(dir, 'a.jsonl', lines)), { key: 'TASK-1' }), null);
});

test('findByKey sums rounds across transcripts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  transcript(path.join(root, 'proj-a'), 's1.jsonl', LINES);
  transcript(path.join(root, 'proj-b'), 's2.jsonl', [human(0, 'ревью'), said(2, '⏱ EST-START TASK-1'), said(12, '⏱ EST-END TASK-1')]);
  transcript(path.join(root, 'proj-c'), 's3.jsonl', [human(0, 'z'), said(1, 'нет метки')]);
  const r = findByKey(root, 'TASK-1');
  assert.strictEqual(r.rounds.length, 2);
  assert.strictEqual(r.total.activeMin, 24 + 10);
  assert.strictEqual(r.total.waitMin, 30);
});

test('findByKey counts a forked transcript (a copy of the history) once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  let n = 0;
  const withIds = LINES.map((l) => ({ ...l, uuid: `u${n++}` }));
  transcript(path.join(root, 'proj'), 'orig.jsonl', withIds);
  transcript(path.join(root, 'proj'), 'fork.jsonl', [...withIds, { ...said(80, 'дальше в форке'), uuid: 'f1' }]);
  const r = findByKey(root, 'TASK-1');
  assert.strictEqual(r.total.activeMin, 24);
  assert.strictEqual(r.total.waitMin, 30);
  assert.strictEqual(r.total.humanMessages, 1);
});

test('a gap of 20 min or more that no human message ends is a pause, not work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const lines = [human(0, 'go'), toolUse(5), toolResult(95), said(100, 'done'), toolUse(119), toolResult(139)];
  const r = measure(parseFile(transcript(dir, 'a.jsonl', lines)));
  assert.strictEqual(r.pauseMin, 90 + 20);
  assert.strictEqual(r.activeMin, 5 + 5 + 19);
  assert.strictEqual(r.waitMin, 0);
});

test('slugFor maps a working folder to its transcripts folder', () => {
  assert.strictEqual(
    slugFor('W:\\ai-dev-hub\\projects\\demo\\worktrees\\TASK-7'),
    'W--ai-dev-hub-projects-demo-worktrees-TASK-7',
  );
});
