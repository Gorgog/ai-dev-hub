// node --test plugin/hooks/estimate-marks.test.cjs
// stop.d/20-estimate-marks.cjs through the spine, as Claude Code runs it: `node run.cjs Stop` with the event on stdin.
// The marks of the turn — in Claude's text, in its messages to the dispatcher mid-turn, in the last message — land in
// projects/<name>/memory/est-marks.jsonl, where `session-time.cjs key` finds the transcripts of a task.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUN = path.join(__dirname, 'run.cjs');
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

let n = 0;
const said = (text) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: '2026-10-01T10:00:00Z', message: { content: [{ type: 'text', text }] } });
const sent = (message) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: '2026-10-01T10:01:00Z',
  message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'SendMessage', input: { to: 'dispatcher', message } }] } });
const human = (text) => ({ type: 'user', uuid: `u${++n}`, timestamp: '2026-10-01T09:59:00Z', message: { content: text } });

function hub({ canary = ['estimate'] } = {}) {
  const h = mkdtemp('em-');
  const proj = path.join(h, 'projects', 'demo');
  const wt = path.join(proj, 'worktrees', 'DEMO-5');
  fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  if (canary) write(path.join(proj, 'canary.json'), JSON.stringify({ mechanisms: canary }));
  return { h, proj, wt, marks: path.join(proj, 'memory', 'est-marks.jsonl'), log: path.join(h, 'log') };
}

function stop(fx, ev) {
  const r = spawnSync(process.execPath, [RUN, 'Stop'], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', ...ev }),
    env: { ...process.env, AI_DEV_HUB: fx.h, HUB_LOG_DIR: fx.log, HUB_OFF: '' }, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  return r;
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('Stop: a mark sent to the dispatcher mid-turn and one in the last message land in the project index', () => {
  const fx = hub();
  const tr = path.join(fx.h, 's1.jsonl');
  write(tr, [human('бриф'), sent('принял бриф\n⏱ EST-START DEMO-5'), said('читаю план')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = stop(fx, { cwd: fx.wt, transcript_path: tr, last_assistant_message: 'Готово.\n⏱ EST-END DEMO-5' });
  assert.strictEqual(r.stdout, '', 'the module never speaks to Claude');
  const got = lines(fx.marks);
  assert.deepStrictEqual(got.map((m) => `${m.kind} ${m.key} ${m.session_id}`), ['START DEMO-5 s1', 'END DEMO-5 s1']);
  assert.strictEqual(got[0].transcript_path, tr);
  assert.strictEqual(got[0].cwd, fx.wt);
  // The next Stop sees the same marks in the tail again: no new lines.
  stop(fx, { cwd: fx.wt, transcript_path: tr, last_assistant_message: '⏱ EST-END DEMO-5' });
  assert.strictEqual(lines(fx.marks).length, 2);
});

test('Stop: silent and harmless — no canary, outside the hub projects, no transcript, a turn without marks', () => {
  const off = hub({ canary: null });
  stop(off, { cwd: off.wt, last_assistant_message: '⏱ EST-START DEMO-5' });
  assert.deepStrictEqual(lines(off.marks), []);
  const fx = hub();
  stop(fx, { cwd: os.tmpdir(), last_assistant_message: '⏱ EST-START DEMO-5' });
  stop(fx, { cwd: fx.wt, transcript_path: path.join(fx.h, 'none.jsonl'), last_assistant_message: 'просто ответ' });
  assert.deepStrictEqual(lines(fx.marks), []);
  stop(fx, { cwd: fx.wt, transcript_path: path.join(fx.h, 'none.jsonl'), last_assistant_message: '⏱ EST-START DEMO-5' });
  assert.deepStrictEqual(lines(fx.marks).map((m) => m.key), ['DEMO-5']);
  const errors = lines(path.join(fx.log, 'hooks.jsonl')).filter((e) => e.type === 'error');
  assert.deepStrictEqual(errors, []);
});
