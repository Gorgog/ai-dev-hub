// node --test note-stub.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sessionFacts, atEnd, atStart } = require('./note-stub.cjs');

const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-11-05T10:00:00Z');
// A synthetic transcript: `tools` tool calls, `edits` of them Edit; cwd and branch on every entry, as Claude Code writes.
function transcript(dir, sid, { cwd, branch = 'K-1', tools = 0, edits = 0, start = T0 } = {}) {
  const base = { sessionId: sid, cwd, gitBranch: branch };
  const lines = [{ type: 'queue-operation', timestamp: new Date(start - 1000).toISOString(), sessionId: sid },
    { ...base, type: 'user', timestamp: new Date(start).toISOString(), message: { role: 'user', content: 'сделай K-1' } }];
  for (let i = 0; i < tools; i++) {
    const name = i < edits ? 'Edit' : 'Bash';
    lines.push({ ...base, type: 'assistant', timestamp: new Date(start + (i + 1) * 1000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'ок' }, { type: 'tool_use', id: `t${i}`, name, input: {} }] } });
  }
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

function setup() {
  const hub = mkdtemp('ns-');
  const proj = { dir: path.join(hub, 'projects', 'demo'), name: 'demo' };
  const wt = path.join(proj.dir, 'worktrees', 'K-1');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(path.join(proj.dir, 'memory', 'sessions'), { recursive: true });
  const tdir = mkdtemp('ns-tr-');
  const notes = () => fs.readdirSync(path.join(proj.dir, 'memory', 'sessions')).sort();
  const note = (name, mtime) => { const f = path.join(proj.dir, 'memory', 'sessions', name); fs.writeFileSync(f, `# ${name}\n`); fs.utimesSync(f, mtime / 1000, mtime / 1000); };
  return { proj, wt, tdir, notes, note };
}

test('sessionFacts: start, cwd and branch from the entries, work = an edit or ≥ 10 tool calls', () => {
  const { wt, tdir } = setup();
  const f = sessionFacts(transcript(tdir, 'a1', { cwd: wt, tools: 3, edits: 1 }));
  assert.strictEqual(f.start, T0);
  assert.strictEqual(f.cwd, wt);
  assert.strictEqual(f.branch, 'K-1');
  assert.strictEqual(f.work, true);
  assert.strictEqual(sessionFacts(transcript(tdir, 'a2', { cwd: wt, tools: 3 })).work, false);
  assert.strictEqual(sessionFacts(transcript(tdir, 'a3', { cwd: wt, tools: 10 })).work, true);
  assert.strictEqual(sessionFacts(path.join(tdir, 'missing.jsonl')), null);
});

test('atEnd: a session with work and no note of its branch since its start leaves a stub with «Дальше»; once', () => {
  const { proj, wt, tdir, notes } = setup();
  const tr = transcript(tdir, 'abcdef12-0000', { cwd: wt, tools: 2, edits: 1 });
  const ev = { hook_event_name: 'SessionEnd', session_id: 'abcdef12-0000', transcript_path: tr, cwd: wt, reason: 'other' };
  const file = atEnd(ev, proj);
  assert.ok(file, 'stub written');
  assert.deepStrictEqual(notes(), [path.basename(file)]);
  assert.match(path.basename(file), /^\d{4}-\d{2}-\d{2}-K-1-stub-abcdef12\.md$/);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /wind-down/);
  assert.match(text, new RegExp(tr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /^## Дальше\n- /m);
  assert.strictEqual(atEnd(ev, proj), null, 'a second SessionEnd of the same session does not duplicate');
  assert.strictEqual(notes().length, 1);
});

test('atEnd: silent when wind-down wrote the note, when there was no work, outside a project', () => {
  const { proj, wt, tdir, notes, note } = setup();
  note('2026-11-05-K-1-feature.md', T0 + 60_000);
  const tr = transcript(tdir, 's1', { cwd: wt, tools: 5, edits: 2 });
  assert.strictEqual(atEnd({ session_id: 's1', transcript_path: tr, cwd: wt, reason: 'prompt_input_exit' }, proj), null);
  const idle = transcript(tdir, 's2', { cwd: wt, branch: 'K-1', tools: 2 });
  assert.strictEqual(atEnd({ session_id: 's2', transcript_path: idle, cwd: wt }, proj), null);
  assert.strictEqual(atEnd({ session_id: 's1', transcript_path: tr, cwd: wt }, null), null);
  assert.deepStrictEqual(notes(), ['2026-11-05-K-1-feature.md']);
});

test('atEnd: an old note of the branch (before the session) does not count; another branch\'s fresh note does not either', () => {
  const { proj, wt, tdir, notes, note } = setup();
  note('2026-11-04-K-1-old.md', T0 - 3600_000);
  note('2026-11-05-K-12-other.md', T0 + 60_000);
  const tr = transcript(tdir, 'deadbeef-1', { cwd: wt, tools: 1, edits: 1 });
  assert.ok(atEnd({ session_id: 'deadbeef-1', transcript_path: tr, cwd: wt }, proj));
  assert.strictEqual(notes().filter((n) => /stub-deadbeef/.test(n)).length, 1);
});

test('atEnd: a trunk or a project-folder session — stub named «session», any fresh note counts as written', () => {
  const { proj, tdir, notes, note } = setup();
  const tr = transcript(tdir, 'cafe0001-x', { cwd: proj.dir, branch: 'main', tools: 1, edits: 1 });
  const file = atEnd({ session_id: 'cafe0001-x', transcript_path: tr, cwd: proj.dir }, proj);
  assert.match(path.basename(file), /^\d{4}-\d{2}-\d{2}-session-stub-cafe0001\.md$/);
  const tr2 = transcript(tdir, 'cafe0002-x', { cwd: proj.dir, branch: 'main', tools: 1, edits: 1 });
  note('2026-11-05-dispatcher-wave.md', T0 + 60_000);
  assert.strictEqual(atEnd({ session_id: 'cafe0002-x', transcript_path: tr2, cwd: proj.dir }, proj), null);
  assert.strictEqual(notes().length, 2);
});

test('atStart: the previous session of this folder without a note or a stub gets one, with a reminder; the current one never', () => {
  const { proj, wt, tdir, notes } = setup();
  const prev = transcript(tdir, 'beef0001-p', { cwd: wt, tools: 1, edits: 1 });
  fs.utimesSync(prev, (T0 + 5000) / 1000, (T0 + 5000) / 1000);
  const cur = transcript(tdir, 'beef0002-c', { cwd: wt, start: T0 + 3600_000 });
  const ev = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'beef0002-c', transcript_path: cur, cwd: wt };
  const r = atStart(ev, proj, { now: T0 + 3600_000 });
  assert.ok(r && r.file);
  assert.match(path.basename(r.file), /K-1-stub-beef0001\.md$/);
  assert.match(r.text, /wind-down/);
  assert.strictEqual(atStart(ev, proj, { now: T0 + 3600_000 }), null, 'stub exists — nothing more');
  assert.strictEqual(notes().length, 1);
});

test('atStart: a previous session that is still fresh (maybe alive), resume and compact — no stub', () => {
  const { proj, wt, tdir, notes } = setup();
  const prev = transcript(tdir, 'f00d0001-p', { cwd: wt, tools: 1, edits: 1 });
  const now = Date.now();
  fs.utimesSync(prev, (now - 30_000) / 1000, (now - 30_000) / 1000);
  const cur = transcript(tdir, 'f00d0002-c', { cwd: wt });
  assert.strictEqual(atStart({ source: 'startup', session_id: 'f00d0002-c', transcript_path: cur, cwd: wt }, proj, { now }), null);
  fs.utimesSync(prev, (now - 3600_000) / 1000, (now - 3600_000) / 1000);
  for (const source of ['resume', 'compact']) {
    assert.strictEqual(atStart({ source, session_id: 'f00d0002-c', transcript_path: cur, cwd: wt }, proj, { now }), null, source);
  }
  assert.deepStrictEqual(notes(), []);
});
