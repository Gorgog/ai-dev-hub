// node --test stop.test.cjs — v1 doneGate (stop.cjs) and the Stop modules of the done-gate (stop.d/10, 11).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { doneGate } = require('./stop.cjs');
const gate = require('./stop.d/10-done-gate.cjs');
const factsMod = require('./stop.d/11-done-facts.cjs');
// Temp folders of this file, removed after its tests.
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function repo() {
  const hub = mkdtemp('st-');
  const r = path.join(hub, 'projects', 'demo', 'repo');
  fs.mkdirSync(r, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'a.txt'), '1'); git('add', '.'); git('commit', '-q', '-m', 'x');
  return { hub, r, sha: git('rev-parse', '--short', 'HEAD') };
}

test('done-gate: «готово к пушу» needs a clean tree and the HEAD sha in the text', () => {
  const { hub, r, sha } = repo();
  assert.strictEqual(doneGate({ cwd: r, last_assistant_message: `Готово к пушу: K-1 ${sha}` }, hub), null);
  const noSha = doneGate({ cwd: r, last_assistant_message: 'Готово к пушу, всё проверено' }, hub);
  assert.strictEqual(noSha.decision, 'block');
  assert.match(noSha.reason, new RegExp(sha));
  fs.writeFileSync(path.join(r, 'a.txt'), 'changed');
  const dirty = doneGate({ cwd: r, last_assistant_message: `Готово к пушу ${sha}` }, hub);
  assert.strictEqual(dirty.decision, 'block');
  assert.match(dirty.reason, /не чистое: a\.txt/);
});

test('done-gate: silent without the phrase, on «не готово к пушу», on stop_hook_active, in the project folder and outside the hub', () => {
  const { hub, r } = repo();
  fs.writeFileSync(path.join(r, 'b.txt'), 'dirty');
  assert.strictEqual(doneGate({ cwd: r, last_assistant_message: 'сделал половину' }, hub), null);
  assert.strictEqual(doneGate({ cwd: r, last_assistant_message: 'Ещё не готово к пушу: жду ревью' }, hub), null);
  assert.strictEqual(doneGate({ cwd: r, last_assistant_message: 'Готово к пушу', stop_hook_active: true }, hub), null);
  assert.strictEqual(doneGate({ cwd: path.dirname(r), last_assistant_message: 'Готово к пушу: K-1 abc1234' }, hub), null);
  assert.strictEqual(doneGate({ cwd: os.tmpdir(), last_assistant_message: 'Готово к пушу' }, hub), null);
});

const project = (hub) => ({ dir: path.join(hub, 'projects', 'demo'), name: 'demo' });
const canary = (hub) => fs.writeFileSync(path.join(hub, 'projects', 'demo', 'canary.json'), JSON.stringify({ mechanisms: ['done-gate'] }));
const run = (mod, hub, cwd, msg, extra = {}) => mod.run({ cwd, last_assistant_message: msg, ...extra }, { project: project(hub), hub });

test('done-gate module: outside the canary — v1 as on main (a mention with the phrase on a dirty tree is still blocked)', () => {
  const { hub, r, sha } = repo();
  assert.strictEqual(run(gate, hub, r, `Готово к пушу: K-1 ${sha}`, {}), null);
  fs.writeFileSync(path.join(r, 'b.txt'), 'dirty');
  const v1 = run(gate, hub, r, 'Дальше: допишу тест и пришлю «готово к пушу» с sha.');
  assert.strictEqual(v1 && v1.decision, 'block');
  assert.strictEqual(run(gate, hub, r, 'Готово к мержу: K-1'), null, 'v1 does not judge «готово к мержу»');
});

test('done-gate module: on the canary it steps aside — done-facts judges the report by facts', () => {
  const { hub, r, sha } = repo();
  canary(hub);
  fs.writeFileSync(path.join(r, 'b.txt'), 'dirty');
  assert.strictEqual(run(gate, hub, r, 'Готово к пушу'), null);
  assert.strictEqual(run(factsMod, hub, r, 'Дальше: допишу тест и пришлю «готово к пушу» с sha.'), null, 'a mention');
  assert.match(run(factsMod, hub, r, `Готово к пушу: K-1 ${sha}`).reason, /не чистое: b\.txt/);
  fs.rmSync(path.join(r, 'b.txt'));
  assert.match(run(factsMod, hub, r, 'Готово к мержу: K-1').reason, /«Готово к мержу».*нет HEAD/);
  fs.writeFileSync(path.join(hub, 'projects', 'demo', 'checks.json'), '{"full": []}');
  assert.match(run(factsMod, hub, r, `Готово к пушу: K-1 ${sha}`).reason, /checks\.cjs --full/);
  const full = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf8' }).trim();
  const file = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hub/last-full.json'], { cwd: r, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sha: full, code: 0, clean: true }));
  assert.strictEqual(run(factsMod, hub, r, `Готово к пушу: K-1 ${sha}`), null);
  assert.strictEqual(run(factsMod, hub, r, 'Готово к пушу: K-1', { stop_hook_active: true }), null);
});
