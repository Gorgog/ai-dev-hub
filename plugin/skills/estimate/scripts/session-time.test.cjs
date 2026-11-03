// node --test session-time.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFile, measure, slugFor, findByKey, candidates, withBuffer, BUFFER_PCT } = require('./session-time.cjs');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-10-20T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const human = (min, text) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: text } });
const said = (min, text) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'text', text }] } });
const toolUse = (min) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo EST-START TASK-1' } }] } });
const toolResult = (min) => ({ type: 'user', timestamp: at(min), message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const callTool = (min, name, id) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const answerTool = (min, id) => ({ type: 'user', timestamp: at(min), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'answer' }] } });

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

// The 30-min answer in LINES (said 20 → human 50): 20 min of waiting, the rest the user was away (pause).
test('whole transcript: active and waiting split at human messages', () => {
  const dir = tmp();
  const r = measure(parseFile(transcript(dir, 'a.jsonl', LINES)));
  assert.strictEqual(r.activeMin, 1 + 9 + 1 + 9 + 5 + 5 + 5);
  assert.strictEqual(r.waitMin, 20 + 5);
  assert.strictEqual(r.pauseMin, 10);
  assert.strictEqual(r.humanMessages, 2);
});

test('key window: from EST-START to EST-END in assistant text only', () => {
  const dir = tmp();
  const r = measure(parseFile(transcript(dir, 'a.jsonl', LINES)), { key: 'TASK-1' });
  assert.strictEqual(r.activeMin, 9 + 1 + 9 + 5);
  assert.strictEqual(r.waitMin, 20);
  assert.strictEqual(r.humanMessages, 1);
  assert.strictEqual(r.ended, true);
});

test('key without EST-END runs to the end of the transcript', () => {
  const dir = tmp();
  const lines = LINES.filter((l) => !JSON.stringify(l).includes('EST-END'));
  const r = measure(parseFile(transcript(dir, 'a.jsonl', lines)), { key: 'TASK-1' });
  assert.strictEqual(r.ended, false);
  assert.strictEqual(r.activeMin, 9 + 1 + 9 + 5 + 5);
  assert.strictEqual(r.waitMin, 20 + 10);
});

test('a human answer after a night: 20 min of waiting, the rest is a pause', () => {
  const dir = tmp();
  const r = measure(parseFile(transcript(dir, 'a.jsonl', [human(0, 'go'), said(1, 'Пушить?'), human(301, 'да')])));
  assert.strictEqual(r.activeMin, 1);
  assert.strictEqual(r.waitMin, 20);
  assert.strictEqual(r.pauseMin, 280);
  assert.strictEqual(r.humanMessages, 1);
});

for (const name of ['AskUserQuestion', 'ExitPlanMode']) {
  test(`an answer to ${name} is the user's waiting, not work`, () => {
    const dir = tmp();
    const lines = [human(0, 'go'), callTool(1, name, 'q1'), answerTool(4, 'q1'), said(5, 'ok')];
    const r = measure(parseFile(transcript(dir, 'a.jsonl', lines)));
    assert.strictEqual(r.activeMin, 1 + 1);
    assert.strictEqual(r.waitMin, 3);
    assert.strictEqual(r.humanMessages, 1);
  });
}

test('a result of an ordinary tool stays active', () => {
  const dir = tmp();
  const lines = [human(0, 'go'), callTool(1, 'Bash', 'b1'), answerTool(4, 'b1'), said(5, 'ok')];
  const r = measure(parseFile(transcript(dir, 'a.jsonl', lines)));
  assert.strictEqual(r.activeMin, 5);
  assert.strictEqual(r.waitMin, 0);
});

test('TASK-1 does not match TASK-12', () => {
  const dir = tmp();
  const lines = [human(0, 'x'), said(1, '⏱ EST-START TASK-12'), said(5, 'y')];
  assert.strictEqual(measure(parseFile(transcript(dir, 'a.jsonl', lines)), { key: 'TASK-1' }), null);
});

// A session under the dispatcher puts its markers in the messages it sends; the dispatcher's brief quotes them.
const tool = (min, name, input) => ({ type: 'assistant', timestamp: at(min), message: { content: [{ type: 'tool_use', id: `t${min}`, name, input }] } });
const BRIEF = 'Первым делом ответь диспетчеру «принял бриф» и отдельной строкой `⏱ EST-START TASK-7`; в докладе `⏱ EST-END TASK-7`.';

test('key window: markers in a sent message on their own line count, a brief quoting them does not', () => {
  const root = tmp();
  // The dispatcher: writes the brief, starts the session, relays a reminder — none of it opens a window.
  transcript(path.join(root, 'hub'), 'dispatcher.jsonl', [
    human(0, 'запусти TASK-7'),
    tool(1, 'Write', { file_path: '/x/brief.md', content: BRIEF }),
    tool(2, 'mcp__ccd_session__start_session', { prompt: BRIEF }),
    tool(3, 'SendMessage', { to: 'task', message: `Напоминаю: ${BRIEF}` }),
    said(4, 'запустил'),
  ]);
  // The task session: its «принял бриф» and its report go to the dispatcher through SendMessage.
  transcript(path.join(root, 'wt-TASK-7'), 'task.jsonl', [
    human(0, BRIEF),
    tool(1, 'SendMessage', { to: 'dispatcher', message: 'TASK-7: принял бриф.\n⏱ EST-START TASK-7' }),
    toolResult(2),
    said(15, 'сделано'),
    toolResult(28),
    tool(41, 'mcp__ccd_session_mgmt__send_message', { message: 'готово к пушу: TASK-7 abc123\n\n`⏱ EST-END TASK-7`' }),
    said(50, 'после доклада'),
  ]);
  const r = findByKey(root, 'TASK-7');
  assert.strictEqual(r.rounds.length, 1);
  assert.strictEqual(path.basename(r.rounds[0].file), 'task.jsonl');
  assert.strictEqual(r.rounds[0].ended, true);
  assert.strictEqual(r.total.activeMin, 40);
});

test('+20% reserve: next to active time, rounded to a minute; the measured figure is untouched', () => {
  assert.strictEqual(BUFFER_PCT, 20);
  assert.strictEqual(withBuffer(48), 58);
  assert.strictEqual(withBuffer(27), 32);
  assert.strictEqual(withBuffer(0), 0);
  assert.strictEqual(withBuffer(100, 50), 150);
  const { execFileSync } = require('child_process');
  const root = tmp();
  transcript(path.join(root, 'p'), 's.jsonl', [human(0, 'x'), said(1, '⏱ EST-START TASK-1'), said(11, '⏱ EST-END TASK-1')]);
  const out = execFileSync(process.execPath, [path.join(__dirname, 'session-time.cjs'), 'key', 'TASK-1', '--root', root], { encoding: 'utf8' });
  assert.match(out, /TOTAL {2}active 10 min {2}\+20% 12 min {2}wait/);
});

test('findByKey sums rounds across transcripts', () => {
  const root = tmp();
  transcript(path.join(root, 'proj-a'), 's1.jsonl', LINES);
  transcript(path.join(root, 'proj-b'), 's2.jsonl', [human(0, 'ревью'), said(2, '⏱ EST-START TASK-1'), said(12, '⏱ EST-END TASK-1')]);
  transcript(path.join(root, 'proj-c'), 's3.jsonl', [human(0, 'z'), said(1, 'нет метки')]);
  const r = findByKey(root, 'TASK-1');
  assert.strictEqual(r.rounds.length, 2);
  assert.strictEqual(r.total.activeMin, 24 + 10);
  assert.strictEqual(r.total.waitMin, 20);
});

test('findByKey counts a forked transcript (a copy of the history) once', () => {
  const root = tmp();
  let n = 0;
  const withIds = LINES.map((l) => ({ ...l, uuid: `u${n++}` }));
  transcript(path.join(root, 'proj'), 'orig.jsonl', withIds);
  transcript(path.join(root, 'proj'), 'fork.jsonl', [...withIds, { ...said(80, 'дальше в форке'), uuid: 'f1' }]);
  const r = findByKey(root, 'TASK-1');
  assert.strictEqual(r.total.activeMin, 24);
  assert.strictEqual(r.total.waitMin, 20);
  assert.strictEqual(r.total.humanMessages, 1);
});

test('a gap of 20 min or more that no human message ends is a pause, not work', () => {
  const dir = tmp();
  const lines = [human(0, 'go'), toolUse(5), toolResult(95), said(100, 'done'), toolUse(119), toolResult(139)];
  const r = measure(parseFile(transcript(dir, 'a.jsonl', lines)));
  assert.strictEqual(r.pauseMin, 90 + 20);
  assert.strictEqual(r.activeMin, 5 + 5 + 19);
  assert.strictEqual(r.waitMin, 0);
});

test('slugFor maps a working folder to its transcripts folder', () => {
  assert.strictEqual(slugFor('/home/u/ai-dev-hub/projects/demo/worktrees/TASK-7'), '-home-u-ai-dev-hub-projects-demo-worktrees-TASK-7');
});

test('candidates: only top-level transcripts that mention the marker, not subagent files deeper down', () => {
  const root = tmp();
  transcript(path.join(root, 'proj-a'), 's1.jsonl', LINES);
  transcript(path.join(root, 'proj-a', 's1', 'subagents'), 'agent.jsonl', LINES);
  transcript(path.join(root, 'proj-b'), 's2.jsonl', [human(0, 'z'), said(1, 'нет метки')]);
  fs.writeFileSync(path.join(root, 'proj-b', 'notes.txt'), 'EST-START TASK-1');
  assert.deepStrictEqual(candidates(root, 'EST-START TASK-1'), [path.join(root, 'proj-a', 's1.jsonl')]);
  assert.deepStrictEqual(candidates(root, 'EST-START NOPE-1'), []);
});
